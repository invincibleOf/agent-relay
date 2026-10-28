import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { Styles } from "../shared/ui.js";
import { visibleWidth } from "../shared/ui.js";

/** El usuario cerró la entrada (Ctrl+D con el campo vacío o Ctrl+C dos veces). */
export class InputClosed extends Error {
  constructor() {
    super("entrada cerrada");
  }
}

export interface ReadOptions {
  /** Prompt de la primera línea (puede llevar colores). */
  prompt: string;
  /** Permite varias líneas (pegado, \ + Enter, Option/Shift+Enter, Ctrl+J). */
  multiline?: boolean;
  /** Usa y guarda el historial. */
  history?: boolean;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

type TTYIn = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
type TTYOut = NodeJS.WritableStream & { columns?: number; on(event: "resize", fn: () => void): unknown };

/** Pegados más largos que esto se muestran resumidos, como en Claude Code. */
const PASTE_COLLAPSE_LINES = 4;
const PASTE_COLLAPSE_CHARS = 800;
/** Cada pegado resumido ocupa un carácter de uso privado en el búfer. */
const PASTE_BASE = 0xe100;
const HISTORY_MAX = 500;
const HISTORY_ENTRY_MAX = 20_000;
const SHIFT_ENTER = new Set(["\x1b[13;2u", "\x1b[27;2;13~", "\x1b[13;3u", "\x1b[27;3;13~"]);

/**
 * Editor de entrada para la terminal: admite pegar texto de varias líneas
 * (bracketed paste), escribir saltos de línea y editar con los atajos
 * habituales. Mantiene la terminal en modo raw mientras la sesión está
 * abierta, así que también recibe Ctrl+C cuando no se está leyendo.
 */
export class InputEditor {
  private chars: string[] = [];
  private cursor = 0;
  private pastes: string[] = [];
  private pasting: string | null = null;
  private active: { opts: ReadOptions; resolve: (s: string) => void; reject: (e: unknown) => void } | null = null;
  private cursorRow = 0;
  private hint = "";
  private lastCtrlC = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft: string[] = [];
  private interruptHandler?: () => void;
  private completions: () => string[] = () => [];
  private started = false;

  constructor(
    private input: TTYIn,
    private output: TTYOut,
    private st: Styles,
    private historyFile?: string,
  ) {
    if (historyFile) {
      try {
        const parsed = JSON.parse(readFileSync(historyFile, "utf8"));
        if (Array.isArray(parsed)) this.history = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        /* sin historial previo */
      }
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    emitKeypressEvents(this.input as NodeJS.ReadStream);
    this.input.setRawMode?.(true);
    this.input.resume();
    this.output.write("\x1b[?2004h"); // bracketed paste
    this.input.on("keypress", this.onKey);
    this.output.on("resize", () => this.active && this.render());
    process.once("exit", () => this.stop());
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.input.removeListener("keypress", this.onKey);
    this.output.write("\x1b[?2004l");
    this.input.setRawMode?.(false);
    this.input.pause();
  }

  /** Ctrl+C cuando no se está leyendo (p. ej. para cancelar el turno en curso). */
  onInterrupt(fn: () => void) {
    this.interruptHandler = fn;
  }

  /** Candidatos para completar con Tab cuando el texto empieza con "/". */
  setCompletions(fn: () => string[]) {
    this.completions = fn;
  }

  read(opts: ReadOptions): Promise<string> {
    if (this.active) return Promise.reject(new Error("ya hay una lectura en curso"));
    this.chars = [];
    this.cursor = 0;
    this.pastes = [];
    this.historyIndex = -1;
    this.hint = "";
    this.cursorRow = 0;
    return new Promise((resolve, reject) => {
      this.active = { opts, resolve, reject };
      this.render();
    });
  }

  // ─── Teclado ───────────────────────────────────────────────────────────────

  private onKey = (ch: string | undefined, key: Key = {}) => {
    if (key.name === "paste-start") {
      this.pasting = "";
      return;
    }
    if (key.name === "paste-end") {
      const text = this.pasting ?? "";
      this.pasting = null;
      if (this.active) this.insertPaste(text);
      return;
    }
    if (this.pasting !== null) {
      this.pasting += ch ?? key.sequence ?? "";
      return;
    }

    if (!this.active) {
      if (key.ctrl && key.name === "c") this.interruptHandler?.();
      return; // se ignora lo que se escriba mientras el agente trabaja
    }

    const multiline = this.active.opts.multiline ?? false;
    this.hint = "";

    if (key.ctrl && key.name === "c") {
      if (this.chars.length) {
        this.chars = [];
        this.cursor = 0;
        this.pastes = [];
      } else if (Date.now() - this.lastCtrlC < 1500) {
        return this.close();
      } else {
        this.lastCtrlC = Date.now();
        this.hint = "Ctrl+C otra vez para salir";
      }
      return this.render();
    }
    if (key.ctrl && key.name === "d") {
      if (!this.chars.length) return this.close();
      this.deleteForward();
      return this.render();
    }

    const seq = key.sequence ?? "";
    if (SHIFT_ENTER.has(seq) || (key.name === "return" && key.meta) || key.name === "enter") {
      if (multiline) this.insert("\n");
      return this.render();
    }
    if (key.name === "return") {
      if (multiline && this.chars[this.cursor - 1] === "\\") {
        this.chars.splice(this.cursor - 1, 1, "\n");
        return this.render();
      }
      return this.submit();
    }

    switch (key.name) {
      case "backspace":
        if (key.meta || key.ctrl) this.deleteWordBack();
        else if (this.cursor > 0) this.chars.splice(--this.cursor, 1);
        return this.render();
      case "delete":
        this.deleteForward();
        return this.render();
      case "left":
        this.cursor = key.meta || key.ctrl ? this.wordLeft() : Math.max(0, this.cursor - 1);
        return this.render();
      case "right":
        this.cursor = key.meta || key.ctrl ? this.wordRight() : Math.min(this.chars.length, this.cursor + 1);
        return this.render();
      case "home":
        this.cursor = this.lineStart();
        return this.render();
      case "end":
        this.cursor = this.lineEnd();
        return this.render();
      case "up":
        return this.vertical(-1);
      case "down":
        return this.vertical(1);
      case "tab":
        this.complete();
        return this.render();
    }

    if (key.ctrl) {
      switch (key.name) {
        case "a":
          this.cursor = this.lineStart();
          break;
        case "e":
          this.cursor = this.lineEnd();
          break;
        case "u":
          this.chars.splice(this.lineStart(), this.cursor - this.lineStart());
          this.cursor = this.lineStart();
          break;
        case "k":
          this.chars.splice(this.cursor, this.lineEnd() - this.cursor);
          break;
        case "w":
          this.deleteWordBack();
          break;
        case "l":
          this.output.write("\x1b[2J\x1b[H");
          this.cursorRow = 0;
          break;
        case "p":
          return this.vertical(-1);
        case "n":
          return this.vertical(1);
        case "j":
          if (multiline) this.insert("\n");
          break;
      }
      return this.render();
    }
    if (key.meta) {
      if (key.name === "b") this.cursor = this.wordLeft();
      else if (key.name === "f") this.cursor = this.wordRight();
      return this.render();
    }

    if (ch && ch >= " " && !seq.startsWith("\x1b")) {
      this.insert(ch);
      this.render();
    }
  };

  private insert(text: string) {
    const items = [...text];
    this.chars.splice(this.cursor, 0, ...items);
    this.cursor += items.length;
  }

  private insertPaste(raw: string) {
    let text = raw.replace(/\r\n?/g, "\n");
    const multiline = this.active?.opts.multiline ?? false;
    if (!multiline) text = text.replace(/\n+/g, " ").trim();
    const lines = text.split("\n").length;
    if (multiline && (lines >= PASTE_COLLAPSE_LINES || text.length > PASTE_COLLAPSE_CHARS)) {
      const id = this.pastes.push(text) - 1;
      this.insert(String.fromCodePoint(PASTE_BASE + id));
    } else {
      this.insert(text);
    }
    this.render();
  }

  private deleteForward() {
    if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
  }

  private deleteWordBack() {
    const to = this.wordLeft();
    this.chars.splice(to, this.cursor - to);
    this.cursor = to;
  }

  private wordLeft(): number {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.chars[i - 1])) i--;
    return i;
  }

  private wordRight(): number {
    let i = this.cursor;
    const n = this.chars.length;
    while (i < n && /\s/.test(this.chars[i])) i++;
    while (i < n && !/\s/.test(this.chars[i])) i++;
    return i;
  }

  private lineStart(at = this.cursor): number {
    let i = at;
    while (i > 0 && this.chars[i - 1] !== "\n") i--;
    return i;
  }

  private lineEnd(at = this.cursor): number {
    let i = at;
    while (i < this.chars.length && this.chars[i] !== "\n") i++;
    return i;
  }

  /** Arriba/abajo: entre líneas del texto o, en los bordes, por el historial. */
  private vertical(dir: -1 | 1) {
    const start = this.lineStart();
    const col = this.cursor - start;
    if (dir === -1 && start > 0) {
      const prevStart = this.lineStart(start - 1);
      this.cursor = Math.min(prevStart + col, start - 1);
      return this.render();
    }
    const end = this.lineEnd();
    if (dir === 1 && end < this.chars.length) {
      const nextStart = end + 1;
      this.cursor = Math.min(nextStart + col, this.lineEnd(nextStart));
      return this.render();
    }
    if (!this.active?.opts.history || !this.history.length) return this.render();

    if (this.historyIndex === -1) {
      if (dir === 1) return this.render();
      this.draft = [...this.chars];
      this.historyIndex = this.history.length;
    }
    const next = this.historyIndex + dir;
    if (next < 0) return this.render();
    if (next >= this.history.length) {
      this.historyIndex = -1;
      this.chars = [...this.draft];
    } else {
      this.historyIndex = next;
      this.chars = [...this.history[next]];
    }
    this.pastes = [];
    this.cursor = this.chars.length;
    this.render();
  }

  /** Tab con "/algo": completa el comando o muestra las opciones. */
  private complete() {
    const text = this.chars.join("");
    if (!/^\/\S*$/.test(text) || this.cursor !== this.chars.length) {
      this.insert("  ");
      return;
    }
    const matches = [...new Set(this.completions())].filter((c) => c.startsWith(text)).sort();
    if (matches.length === 1) this.chars = [...`${matches[0]} `];
    else if (matches.length > 1) {
      let prefix = matches[0];
      for (const m of matches) while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (prefix.length > text.length) this.chars = [...prefix];
      else this.hint = matches.join("  ");
    }
    this.cursor = this.chars.length;
  }

  private submit() {
    const active = this.active!;
    const display = this.chars.join("");
    const value = this.expand(display);
    this.hint = "";
    this.cursor = this.chars.length;
    this.render();
    this.output.write("\n");
    this.active = null;
    this.cursorRow = 0;
    if (active.opts.history && value.trim()) this.remember(value);
    active.resolve(value);
  }

  private close() {
    const active = this.active;
    this.hint = "";
    this.render();
    this.output.write("\n");
    this.active = null;
    this.cursorRow = 0;
    active?.reject(new InputClosed());
  }

  /** Reemplaza los pegados resumidos por su contenido completo. */
  private expand(display: string): string {
    return [...display]
      .map((c) => {
        const id = c.codePointAt(0)! - PASTE_BASE;
        return id >= 0 && id < this.pastes.length ? this.pastes[id] : c;
      })
      .join("");
  }

  private remember(value: string) {
    if (value.length > HISTORY_ENTRY_MAX) return;
    if (this.history.at(-1) !== value) this.history.push(value);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    if (!this.historyFile) return;
    try {
      mkdirSync(path.dirname(this.historyFile), { recursive: true });
      writeFileSync(this.historyFile, JSON.stringify(this.history), { mode: 0o600 });
    } catch {
      /* el historial es opcional */
    }
  }

  // ─── Dibujo ────────────────────────────────────────────────────────────────

  private pasteLabel(c: string): string | undefined {
    const id = c.codePointAt(0)! - PASTE_BASE;
    if (id < 0 || id >= this.pastes.length) return undefined;
    const text = this.pastes[id];
    const lines = text.split("\n").length;
    return this.st.accent(`[texto pegado #${id + 1} · ${lines} línea${lines === 1 ? "" : "s"} · ${text.length} caracteres]`);
  }

  private render() {
    if (!this.active) return;
    const cols = Math.max(20, this.output.columns || 80);
    const prompt = this.active.opts.prompt;
    const promptWidth = visibleWidth(prompt);
    const cont = this.st.gray("·".padStart(promptWidth - 1).padEnd(promptWidth));

    // Líneas lógicas con su texto visible y su ancho.
    const lines: Array<{ text: string; width: number; widthAt: number[] }> = [{ text: "", width: 0, widthAt: [0] }];
    for (const c of this.chars) {
      const cur = lines[lines.length - 1];
      if (c === "\n") {
        lines.push({ text: "", width: 0, widthAt: [0] });
        continue;
      }
      const shown = this.pasteLabel(c) ?? c;
      cur.text += shown;
      cur.width += visibleWidth(shown);
      cur.widthAt.push(cur.width);
    }

    const rowsOf = (w: number) => Math.max(1, Math.ceil(w / cols));
    let out = "";
    let totalRows = 0;
    lines.forEach((l, i) => {
      out += `${i === 0 ? prompt : cont}${l.text}`;
      if (i < lines.length - 1) out += "\n";
      totalRows += rowsOf(promptWidth + l.width);
    });
    if (this.hint) {
      out += `\n${this.st.gray(this.hint)}`;
      totalRows += rowsOf(visibleWidth(this.hint));
    }

    // Posición del cursor: línea lógica y columna visible.
    let lineIdx = 0;
    let colIdx = 0;
    for (let i = 0; i < this.cursor; i++) {
      if (this.chars[i] === "\n") {
        lineIdx++;
        colIdx = 0;
      } else colIdx++;
    }
    let targetRow = 0;
    for (let i = 0; i < lineIdx; i++) targetRow += rowsOf(promptWidth + lines[i].width);
    const line = lines[lineIdx];
    const x = promptWidth + line.widthAt[colIdx];
    const lineRows = rowsOf(promptWidth + line.width);
    const rowInLine = Math.min(Math.floor(x / cols), lineRows - 1);
    targetRow += rowInLine;
    const targetCol = Math.min(x - rowInLine * cols, cols - 1);

    let seq = "";
    if (this.cursorRow > 0) seq += `\x1b[${this.cursorRow}A`;
    seq += `\r\x1b[J${out}\r`;
    const up = totalRows - 1 - targetRow;
    if (up > 0) seq += `\x1b[${up}A`;
    if (targetCol > 0) seq += `\x1b[${targetCol}C`;
    this.output.write(seq);
    this.cursorRow = targetRow;
  }
}
