import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  methods,
  type ClientConnection,
  type InitializeResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { Styles } from "../shared/ui.js";
import { truncate } from "../shared/ui.js";
import { configDir } from "./config.js";

export interface ActiveSession {
  id: string;
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  title?: string | null;
}

/** Un intercambio reconstruido a partir de la conversación que reproduce el agente. */
export interface ReplayTurn {
  user: string;
  agent: string;
  tools: number;
}

const MAX_LIST_PAGES = 5;

export function canList(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.sessionCapabilities?.list);
}

export function canRestore(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.loadSession || init.agentCapabilities?.sessionCapabilities?.resume);
}

/** Sesiones del proyecto, de la más reciente a la más antigua. */
export async function listSessions(acp: ClientConnection, init: InitializeResponse, root: string): Promise<SessionInfo[]> {
  if (!canList(init)) return [];
  const all: SessionInfo[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await acp.agent.request(methods.agent.session.list, { cwd: root, ...(cursor ? { cursor } : {}) });
    all.push(...res.sessions);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return all
    .filter((s) => !s.cwd || samePath(s.cwd, root))
    .sort((a, b) => Date.parse(b.updatedAt ?? "0") - Date.parse(a.updatedAt ?? "0"));
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Restaura una sesión existente.
 * - `replay: true` usa session/load: el agente reproduce la conversación
 *   (el llamador la recoge con Renderer.beginReplay/endReplay).
 * - `replay: false` prefiere session/resume, que no la reproduce (reconexiones).
 */
export async function restoreSession(
  acp: ClientConnection,
  init: InitializeResponse,
  root: string,
  sessionId: string,
  replay: boolean,
): Promise<Omit<ActiveSession, "title">> {
  const caps = init.agentCapabilities;
  const useLoad = replay ? Boolean(caps?.loadSession) : !caps?.sessionCapabilities?.resume && Boolean(caps?.loadSession);
  if (!useLoad && !caps?.sessionCapabilities?.resume) {
    throw new Error("este agente no permite reanudar sesiones");
  }
  const res = useLoad
    ? await acp.agent.request(methods.agent.session.load, { sessionId, cwd: root, mcpServers: [] })
    : await acp.agent.request(methods.agent.session.resume, { sessionId, cwd: root, mcpServers: [] });
  return { id: sessionId, modes: res?.modes ?? null, configOptions: res?.configOptions ?? [] };
}

/** Resuelve "3" (posición en la lista), un id completo o un prefijo de id. */
export function pickSession(sessions: SessionInfo[], answer: string): SessionInfo | undefined {
  const a = answer.trim();
  if (!a) return undefined;
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= sessions.length) return sessions[n - 1];
  const exact = sessions.find((s) => s.sessionId === a);
  if (exact) return exact;
  const prefixed = sessions.filter((s) => s.sessionId.startsWith(a));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

// ─── Última sesión usada por proyecto (respaldo si el agente no lista) ──────

const lastFile = () => path.join(configDir(), "sessions.json");

function readLast(): Record<string, { sessionId: string; updatedAt: string }> {
  try {
    const data = JSON.parse(readFileSync(lastFile(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function rememberSession(projectId: string, provider: string, sessionId: string) {
  try {
    const data = readLast();
    data[`${projectId}:${provider}`] = { sessionId, updatedAt: new Date().toISOString() };
    mkdirSync(path.dirname(lastFile()), { recursive: true });
    writeFileSync(lastFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    /* es solo un respaldo */
  }
}

export function lastRememberedSession(projectId: string, provider: string): string | undefined {
  return readLast()[`${projectId}:${provider}`]?.sessionId;
}

// ─── Presentación ────────────────────────────────────────────────────────────

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 60) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return "ayer";
  if (d < 7) return `hace ${d} días`;
  return new Date(t).toLocaleDateString("es", { day: "numeric", month: "short", year: d > 300 ? "numeric" : undefined });
}

export function sessionRows(sessions: SessionInfo[], st: Styles, width: number, currentId?: string): string[] {
  const titleWidth = Math.max(20, width - 40);
  return sessions.map((s, i) => {
    const n = st.accent(String(i + 1).padStart(3));
    const title = truncate(cleanTitle(s.title) || st.gray("(sin título)"), titleWidth).padEnd(titleWidth);
    const when = st.gray(relativeTime(s.updatedAt).padEnd(16));
    const id = st.gray(s.sessionId.slice(0, 8));
    const current = s.sessionId === currentId ? st.green("  ← actual") : "";
    return `${n}  ${title}  ${when}${id}${current}`;
  });
}

const cleanTitle = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/** Quita etiquetas internas y marcadores para una vista previa en una línea. */
export function previewText(s: string): string {
  return s
    .replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/```[\s\S]*?```/g, " [código] ")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resumen compacto de la conversación reproducida al reanudar. */
export function transcriptLines(turns: ReplayTurn[], st: Styles, width: number, show = 3): string[] {
  const visible = turns.filter((t) => previewText(t.user) || previewText(t.agent));
  if (!visible.length) return [st.gray("  (la sesión no tiene mensajes todavía)")];
  const out: string[] = [];
  const hidden = visible.length - show;
  if (hidden > 0) out.push(st.gray(`  … ${hidden} intercambio${hidden === 1 ? "" : "s"} anterior${hidden === 1 ? "" : "es"}`));
  for (const t of visible.slice(-show)) {
    const user = previewText(t.user);
    const agent = previewText(t.agent);
    if (user) out.push(`  ${st.accent("›")} ${truncate(user, width - 6)}`);
    if (agent) out.push(`    ${st.gray(truncate(agent, width - 6))}`);
    if (t.tools) out.push(`    ${st.gray(`(${t.tools} herramienta${t.tools === 1 ? "" : "s"})`)}`);
  }
  return out;
}
