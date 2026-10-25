import type { Styles } from "../shared/ui.js";

/**
 * Renderiza Markdown en streaming para la terminal: encabezados, listas,
 * citas, bloques de código, `código`, **negrita**, *cursiva* y [enlaces](url).
 *
 * El texto se emite en cuanto es seguro (en cortes de palabra con los
 * marcadores balanceados), así que la respuesta sigue apareciendo de forma
 * progresiva. Sin TTY, el texto pasa sin cambios.
 */
export class MarkdownStream {
  private pending = "";
  private lineStarted = false;
  private inCode = false;
  private lineStyle: ((s: string) => string) | null = null;

  constructor(
    private st: Styles,
    private write: (s: string) => void,
  ) {}

  push(text: string) {
    if (!this.st.enabled) {
      this.write(text);
      return;
    }
    this.pending += text;
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.emit(line, true);
      this.write("\n");
      this.lineStarted = false;
      this.lineStyle = null;
    }
    if (this.pending) this.pending = this.emit(this.pending, false);
  }

  /** Vacía lo pendiente al final del turno. */
  flush() {
    if (this.pending) this.emit(this.pending, true);
    this.pending = "";
    this.lineStarted = false;
    this.lineStyle = null;
  }

  /** Emite lo que sea seguro de `s` y devuelve lo que queda sin emitir. */
  private emit(s: string, final: boolean): string {
    const st = this.st;

    if (!this.lineStarted) {
      // Hace falta ver el inicio de la línea para decidir su tipo.
      if (!final && s.trimStart().length < 4 && !/[^\s#>*\-`\d.]/.test(s)) return s;

      const fence = /^\s*```/.test(s);
      if (fence) {
        if (!final) return s; // la línea de apertura/cierre se procesa completa
        this.inCode = !this.inCode;
        const lang = s.trim().slice(3).trim();
        this.write(st.gray(this.inCode ? `  ┌─${lang ? ` ${lang} ` : ""}` : "  └─"));
        this.lineStarted = true;
        return "";
      }
      if (this.inCode) {
        this.write(st.gray("  │ "));
        this.lineStarted = true;
      } else {
        const heading = /^(#{1,6})\s+/.exec(s);
        const bullet = /^(\s*)[-*+]\s+/.exec(s);
        const numbered = /^(\s*)(\d+)[.)]\s+/.exec(s);
        const quote = /^>\s?/.exec(s);
        const rule = /^\s*([-*_])(\s*\1){2,}\s*$/.test(s);
        if (rule && final) {
          this.write(st.gray("─".repeat(40)));
          this.lineStarted = true;
          return "";
        }
        if (heading) {
          this.lineStyle = heading[1].length <= 2 ? (x) => st.bold(st.accent(x)) : (x) => st.bold(x);
          s = s.slice(heading[0].length);
        } else if (bullet) {
          this.write(`${bullet[1]}${st.accent("•")} `);
          s = s.slice(bullet[0].length);
        } else if (numbered) {
          this.write(`${numbered[1]}${st.accent(`${numbered[2]}.`)} `);
          s = s.slice(numbered[0].length);
        } else if (quote) {
          this.write(st.gray("│ "));
          this.lineStyle = (x) => st.italic(x);
          s = s.slice(quote[0].length);
        }
        this.lineStarted = true;
      }
    }

    if (this.inCode) {
      this.write(s);
      return "";
    }

    let cut = s.length;
    if (!final) {
      cut = s.lastIndexOf(" ") + 1;
      while (cut > 0 && !balanced(s.slice(0, cut))) cut = s.lastIndexOf(" ", cut - 2) + 1;
      if (cut <= 0) return s;
    }
    const out = inline(s.slice(0, cut), st);
    this.write(this.lineStyle ? this.lineStyle(out) : out);
    return s.slice(cut);
  }
}

function balanced(s: string): boolean {
  const ticks = (s.match(/`/g) ?? []).length;
  const bold = (s.match(/\*\*/g) ?? []).length;
  const links = (s.match(/\[/g) ?? []).length === (s.match(/\)/g) ?? []).length || !s.includes("](");
  return ticks % 2 === 0 && bold % 2 === 0 && links;
}

export function inline(s: string, st: Styles): string {
  return s
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return st.cyan(part.slice(1, -1));
      return part
        .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => st.bold(t))
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, (_, pre: string, t: string) => pre + st.italic(t))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, url: string) => `${st.underline(t)} ${st.gray(`(${url})`)}`);
    })
    .join("");
}
