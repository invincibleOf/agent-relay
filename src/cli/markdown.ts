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
  /** La línea actual ya va en negrita (encabezado). */
  private lineBold = false;

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
      this.lineBold = false;
    }
    if (this.pending) this.pending = this.emit(this.pending, false);
  }

  /** Vacía lo pendiente al final del turno. */
  flush() {
    if (this.pending) this.emit(this.pending, true);
    this.pending = "";
    this.lineStarted = false;
    this.lineStyle = null;
    this.lineBold = false;
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
          this.lineBold = true;
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
    const out = inline(s.slice(0, cut), st, this.lineBold);
    this.write(this.lineStyle ? this.lineStyle(out) : out);
    return s.slice(cut);
  }
}

/** Quita los spans de `código` para contar marcadores fuera de ellos. */
const withoutCode = (s: string) => s.replace(/`[^`]*`/g, "");

/**
 * Un fragmento es seguro de emitir si no deja abierto ningún marcador: código,
 * negrita/cursiva con * o _, ni un enlace a medias.
 */
function balanced(s: string): boolean {
  if ((s.match(/`/g) ?? []).length % 2 !== 0) return false;
  const plain = withoutCode(s);
  // ** y * se cuentan por separado: un ** abierto suma dos asteriscos y no se
  // detectaría contando el total. Un * rodeado de espacios (a * b) no es marcador.
  if ((plain.match(/\*\*/g) ?? []).length % 2 !== 0) return false;
  if ((plain.replace(/\*\*/g, "").match(/\*(?=\S)|(?<=\S)\*/g) ?? []).length % 2 !== 0) return false;
  if ((plain.match(/(^|[^\w])__|__(?!\w)/g) ?? []).length % 2 !== 0) return false;
  if ((plain.match(/(^|[^\w_])_(?=[^\s_])|(?<=[^\s_])_(?![\w_])/g) ?? []).length % 2 !== 0) return false;
  // Un [ sin su ](url) completo puede ser un enlace a medio llegar: se espera.
  // (Corchetes sueltos, como "- [ ]", solo retrasan la línea hasta su final.)
  const opens = (plain.match(/\[/g) ?? []).length;
  const links = (plain.match(/\[[^\]]*\]\([^)\s]*\)/g) ?? []).length;
  const plainBrackets = (plain.match(/\[[^\]]*\](?!\()/g) ?? []).length;
  return opens <= links + plainBrackets;
}

const HOLD_OPEN = "\uE000";
const HOLD_CLOSE = "\uE001";

/**
 * Formato en línea. El código se reemplaza primero por marcadores internos
 * para que la negrita y la cursiva puedan contenerlo (p. ej. **`GET /x`**)
 * sin que se interpreten los * o _ que haya dentro del código.
 *
 * `insideBold`: la línea ya va en negrita (encabezados); los ** internos solo
 * se quitan, para no apagar la negrita del resto de la línea.
 */
export function inline(s: string, st: Styles, insideBold = false): string {
  // Código y enlaces se apartan antes de aplicar estilos: así sus * y _ no se
  // interpretan, y los [ de los códigos de color no se confunden con enlaces.
  const held: string[] = [];
  const hold = (rendered: string) => `${HOLD_OPEN}${held.push(rendered) - 1}${HOLD_CLOSE}`;
  let out = s
    .replace(/`([^`]+)`/g, (_, c: string) => hold(st.cyan(c)))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, url: string) => hold(`${st.underline(t)} ${st.gray(`(${url})`)}`));

  const bold = (t: string) => (insideBold ? t : st.bold(t));
  out = out
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, t: string) => bold(t))
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_, pre: string, t: string) => pre + bold(t))
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, (_, pre: string, t: string) => pre + st.italic(t))
    .replace(/(^|[^\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/g, (_, pre: string, t: string) => pre + st.italic(t));

  return out.replace(new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g"), (_, i: string) => held[Number(i)]);
}
