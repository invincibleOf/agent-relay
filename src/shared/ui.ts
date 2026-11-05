/**
 * Utilidades de presentación para terminal, sin dependencias.
 * Los colores solo se aplican si la salida es una TTY y NO_COLOR no está definido.
 */

export const isTTY = (stream: NodeJS.WriteStream = process.stdout) =>
  Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (open: string, close: string) => (enabled: boolean) => (s: string) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

/** Estilos con cierre específico, para poder anidarlos (negrita dentro de un encabezado). */
export function makeStyles(enabled: boolean) {
  return {
    enabled,
    bold: wrap("1", "22")(enabled),
    dim: wrap("2", "22")(enabled),
    italic: wrap("3", "23")(enabled),
    underline: wrap("4", "24")(enabled),
    red: wrap("31", "39")(enabled),
    green: wrap("32", "39")(enabled),
    yellow: wrap("33", "39")(enabled),
    blue: wrap("34", "39")(enabled),
    magenta: wrap("35", "39")(enabled),
    cyan: wrap("36", "39")(enabled),
    gray: wrap("90", "39")(enabled),
    accent: wrap("38;5;141", "39")(enabled), // violeta
  };
}
export type Styles = ReturnType<typeof makeStyles>;

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** Columnas que ocupa un carácter en la terminal: 0 (combinantes), 1 o 2 (CJK, emoji). */
export function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    [0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55].includes(cp)
  )
    return 2;
  return 1;
}

/** Ancho visible: sin códigos ANSI y con caracteres anchos (un emoji con U+FE0F cuenta 2). */
export function visibleWidth(s: string): number {
  let w = 0;
  let prev = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f && prev === 1) w += 1; // presentación emoji: ⚠️, ✔️
    const cw = charWidth(cp);
    w += cw;
    if (cp !== 0xfe0f) prev = cw;
  }
  return w;
}

export function termWidth(stream: NodeJS.WriteStream = process.stdout): number {
  return Math.max(40, Math.min(stream.columns || 80, 120));
}

export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/** Recorta por la izquierda conservando el final (útil para rutas largas). */
export function truncateStart(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `…${chars.slice(chars.length - max + 1).join("")}`;
}

/** Acorta rutas del home a ~ para mostrarlas. */
export function tildify(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && (p === home || p.startsWith(home + "/") || p.startsWith(home + "\\")) ? `~${p.slice(home.length)}` : p;
}

/** Caja con borde redondeado alrededor de líneas ya formateadas. */
export function box(lines: string[], st: Styles, width?: number): string {
  const inner = Math.max(...lines.map(visibleWidth), 20);
  const w = width ? Math.max(inner, width - 4) : inner;
  const border = (s: string) => st.gray(s);
  const out = [border(`╭${"─".repeat(w + 2)}╮`)];
  for (const l of lines) out.push(`${border("│")} ${l}${" ".repeat(w - visibleWidth(l))} ${border("│")}`);
  out.push(border(`╰${"─".repeat(w + 2)}╯`));
  return out.join("\n");
}

/** Filas "clave  valor" alineadas. */
export function rows(entries: Array<[string, string]>, st: Styles, indent = "  "): string[] {
  const keyWidth = Math.max(...entries.map(([k]) => visibleWidth(k)));
  return entries.map(([k, v]) => `${indent}${st.gray(k.padEnd(keyWidth))}  ${v}`);
}
