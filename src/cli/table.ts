import type { Styles } from "../shared/ui.js";
import { charWidth, visibleWidth } from "../shared/ui.js";

type Align = "left" | "center" | "right";

/** Una línea es candidata a fila de tabla si empieza con "|". */
export const isTableLine = (line: string) => /^\s*\|/.test(line);

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Divide una fila en celdas: respeta \| y los | dentro de `código`. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function alignments(sep: string, n: number): Align[] {
  return Array.from({ length: n }, (_, i) => {
    const c = splitRow(sep)[i]?.trim() ?? "";
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    return "left";
  });
}

// ─── Ajuste de texto con códigos ANSI ────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/y;
/** Código de apertura → código que lo cierra (los mismos que usa makeStyles). */
const CLOSER: Record<string, string> = { "1": "22", "2": "22", "3": "23", "4": "24" };
const closerOf = (code: string) => CLOSER[code] ?? (/^(3\d|9\d|38;5;\d+)$/.test(code) ? "39" : undefined);

interface Token {
  text: string;
  width: number;
  space: boolean;
  lastWidth?: number;
}

/** Parte un texto con estilos en palabras y espacios, sin romper los códigos ANSI. */
function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let cur: Token | null = null;
  while (i < s.length) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m) {
      (cur ??= { text: "", width: 0, space: false }).text += m[0];
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const space = ch === " ";
    // Selector de presentación emoji: no abre palabra nueva y ensancha el carácter anterior.
    if (cp === 0xfe0f && cur && !cur.space) {
      cur.text += ch;
      if (cur.lastWidth === 1) cur.width++;
      cur.lastWidth = 2;
      i += ch.length;
      continue;
    }
    if (!cur || (cur.space !== space && cur.width > 0)) {
      if (cur) tokens.push(cur);
      cur = { text: "", width: 0, space };
    }
    cur.space = space;
    cur.text += ch;
    cur.lastWidth = charWidth(cp);
    cur.width += cur.lastWidth;
    i += ch.length;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Ajusta un texto con estilos a `width` columnas. En cada salto cierra los
 * estilos abiertos y los vuelve a abrir en la línea siguiente.
 */
export function wrapAnsi(s: string, width: number): string[] {
  if (visibleWidth(s) <= width) return [s];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  const open: string[] = []; // códigos abiertos, en orden

  const track = (text: string) => {
    for (const m of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const code = m[1];
      if (code === "0" || code === "") open.length = 0;
      else if (closerOf(code)) open.push(code);
      else {
        for (let k = open.length - 1; k >= 0; k--) if (closerOf(open[k]) === code) open.splice(k, 1);
      }
    }
  };
  const breakLine = () => {
    lines.push(line + (open.length ? "\x1b[0m" : ""));
    line = open.map((c) => `\x1b[${c}m`).join("");
    lineWidth = 0;
  };

  for (const tok of tokenize(s)) {
    if (tok.space && lineWidth === 0) {
      track(tok.text);
      line += tok.text.replace(/ /g, "");
      continue;
    }
    if (lineWidth + tok.width > width && lineWidth > 0) {
      breakLine();
      if (tok.space) {
        track(tok.text);
        line += tok.text.replace(/ /g, "");
        continue;
      }
    }
    if (tok.width > width) {
      // Palabra más larga que la columna: se corta por caracteres.
      for (const part of tok.text.split(/(\x1b\[[0-9;]*m)/)) {
        if (part.startsWith("\x1b[")) {
          track(part);
          line += part;
          continue;
        }
        for (const ch of part) {
          const cw = charWidth(ch.codePointAt(0)!);
          if (lineWidth + cw > width) breakLine();
          line += ch;
          lineWidth += cw;
        }
      }
      continue;
    }
    track(tok.text);
    line += tok.text;
    lineWidth += tok.width;
  }
  if (line) lines.push(line + (open.length ? "\x1b[0m" : ""));
  return lines;
}

// ─── Dibujo ──────────────────────────────────────────────────────────────────

function pad(s: string, width: number, align: Align): string {
  const gap = Math.max(0, width - visibleWidth(s));
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return s + " ".repeat(gap);
}

/** Reparte el ancho disponible: las columnas angostas conservan su ancho y las anchas se reducen. */
function fitWidths(natural: number[], minimal: number[], available: number): number[] {
  const widths = [...natural];
  const total = () => widths.reduce((a, b) => a + b, 0);
  while (total() > available) {
    let idx = -1;
    for (let i = 0; i < widths.length; i++) if (widths[i] > minimal[i] && (idx === -1 || widths[i] > widths[idx])) idx = i;
    if (idx === -1) break; // ya no se puede reducir más
    widths[idx]--;
  }
  return widths;
}

/**
 * Dibuja una tabla de Markdown con bordes. `format` aplica el formato en
 * línea (negrita, `código`…) a cada celda. Si las líneas no forman una tabla
 * válida (falta la fila separadora), devuelve undefined.
 */
export function renderTable(lines: string[], st: Styles, maxWidth: number, format: (s: string, bold?: boolean) => string): string[] | undefined {
  if (lines.length < 2 || !SEPARATOR.test(lines[1])) return undefined;
  const header = splitRow(lines[0]);
  const n = header.length;
  const align = alignments(lines[1], n);
  const body = lines.slice(2).map((l) => {
    const cells = splitRow(l);
    return Array.from({ length: n }, (_, i) => cells[i] ?? "");
  });

  // Sin el selector de emoji (U+FE0F): "⚠️" mide 1 o 2 columnas según la terminal y
  // descuadraría los bordes; "⚠" mide 1 en todas.
  const clean = (c: string) => c.replace(/\uFE0F/g, "");
  const headerCells = header.map((c) => format(clean(c), true));
  const bodyCells = body.map((r) => r.map((c) => format(clean(c))));
  const all = [headerCells, ...bodyCells];

  const natural = Array.from({ length: n }, (_, i) => Math.max(1, ...all.map((r) => visibleWidth(r[i]))));
  // Mínimo: la palabra más larga, hasta 12 columnas (más larga se corta).
  const minimal = Array.from({ length: n }, (_, i) =>
    Math.min(
      natural[i],
      Math.max(3, Math.min(12, ...all.map((r) => Math.max(...tokenize(r[i]).filter((t) => !t.space).map((t) => t.width), 1)))),
    ),
  );
  const available = Math.max(n * 3, maxWidth - (3 * n + 1));
  const widths = fitWidths(natural, minimal, available);

  const b = (s: string) => st.gray(s);
  const rule = (l: string, m: string, r: string) => b(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const row = (cells: string[]) => {
    const wrapped = cells.map((c, i) => wrapAnsi(c, widths[i]));
    const height = Math.max(...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let k = 0; k < height; k++) {
      const parts = wrapped.map((w, i) => pad(w[k] ?? "", widths[i], align[i]));
      out.push(`${b("│")} ${parts.join(` ${b("│")} `)} ${b("│")}`);
    }
    return out;
  };

  return [
    rule("┌", "┬", "┐"),
    ...row(headerCells),
    rule("├", "┼", "┤"),
    ...bodyCells.flatMap((r) => row(r)),
    rule("└", "┴", "┘"),
  ];
}
