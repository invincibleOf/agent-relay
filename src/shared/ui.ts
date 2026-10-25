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
export const visibleWidth = (s: string) => [...stripAnsi(s)].length;

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
