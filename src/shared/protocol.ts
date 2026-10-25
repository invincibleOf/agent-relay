/**
 * Protocolo de control entre el CLI local y el daemon remoto.
 *
 * Una conexión WebSocket pasa por dos fases:
 *   1. Handshake de control: el CLI envía `relay/hello` y el daemon responde
 *      `relay/ready` (o `relay/error`).
 *   2. ACP puro: a partir de ahí cada frame de texto es un mensaje JSON-RPC de
 *      ACP. El daemon los reenvía al adaptador del proveedor (stdio) y de vuelta,
 *      reescribiendo rutas entre la carpeta local y el workspace espejo.
 */

export const RELAY_PROTOCOL_VERSION = 1;

/** Archivo del proyecto que el CLI envía al daemon (AGENTS.md, skills, comandos). */
export interface ProjectFile {
  /** Ruta relativa a la raíz del proyecto, siempre con "/". */
  path: string;
  /** Contenido en base64 (las skills pueden incluir binarios). */
  contentBase64: string;
}

export interface HelloFrame {
  type: "relay/hello";
  protocolVersion: number;
  /** Proveedor pedido; si se omite, el daemon usa su proveedor por defecto. */
  provider?: string;
  project: {
    /** Ruta absoluta de la raíz del proyecto en la máquina local. */
    localRoot: string;
    /** Identificador estable del proyecto (hash de máquina + ruta). */
    id: string;
    /** Nombre legible (carpeta raíz). */
    name: string;
    /** Separador de rutas de la máquina local ("/" o "\\"). */
    pathSeparator: string;
    files: ProjectFile[];
  };
  client: {
    name: string;
    version: string;
    hostname: string;
  };
}

export interface ReadyFrame {
  type: "relay/ready";
  protocolVersion: number;
  provider: string;
  availableProviders: string[];
  /** Ruta del workspace espejo en la máquina remota (informativo). */
  remoteWorkspace: string;
  daemon: { version: string; hostname: string };
  /** Estado del puente de herramientas (ausente en daemons anteriores a v0.4). */
  toolBridge?: { enabled: boolean; preset: string };
}

export interface ErrorFrame {
  type: "relay/error";
  message: string;
}

export type ControlFrame = HelloFrame | ReadyFrame | ErrorFrame;

export function isControlFrame(value: unknown): value is ControlFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type.startsWith("relay/")
  );
}

/**
 * Reescribe recursivamente todos los strings que empiezan con `from` para que
 * empiecen con `to`. Se usa para traducir rutas absolutas entre la máquina
 * local y el workspace espejo remoto en ambos sentidos.
 *
 * Solo se reemplaza un prefijo seguido de fin de string o de un separador,
 * para no tocar rutas hermanas (p. ej. /proyecto vs /proyecto-viejo).
 */
export function rewritePathPrefix<T>(
  value: T,
  from: string,
  to: string,
  fromSep: string,
  toSep: string,
): T {
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return rewriteString(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = visit(inner);
      return out;
    }
    return v;
  };

  const rewriteString = (s: string): string => {
    let idx = s.indexOf(from);
    if (idx === -1) return s;
    let result = "";
    let cursor = 0;
    while (idx !== -1) {
      const after = s.charAt(idx + from.length);
      const before = idx === 0 ? "" : s.charAt(idx - 1);
      const boundaryAfter = after === "" || after === fromSep || after === "/" || /[\s"'`:)\]]/.test(after);
      const boundaryBefore =
        before === "" || /[\s"'`(=:\[]/.test(before) || s.slice(Math.max(0, idx - 7), idx) === "file://";
      if (boundaryAfter && boundaryBefore) {
        result += s.slice(cursor, idx) + to;
        cursor = idx + from.length;
        // Normaliza separadores en el resto de la ruta inmediata.
        if (fromSep !== toSep) {
          const rest = s.slice(cursor);
          const m = rest.match(/^[^\s"'`)\]]*/);
          if (m) {
            result += m[0].split(fromSep).join(toSep);
            cursor += m[0].length;
          }
        }
      }
      idx = s.indexOf(from, idx + from.length);
    }
    return result + s.slice(cursor);
  };

  return visit(value) as T;
}
