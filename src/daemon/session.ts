import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { WebSocket } from "ws";
import { rewritePathPrefix } from "../shared/protocol.js";
import type { ProviderConfig } from "./config.js";
import { BRIDGE_SERVER_NAME, deepMerge, presetSessionMeta, presetSpawnEnv } from "./presets.js";
import type { ClientRequester, ToolBridgeHub } from "./tool-bridge.js";

const CLIENT_REQUEST_TIMEOUT_MS = 120_000;
const SESSION_METHODS = new Set(["session/new", "session/load", "session/resume"]);

export interface BridgeOptions {
  ws: WebSocket;
  providerName: string;
  provider: ProviderConfig;
  /** Workspace espejo en la máquina remota (cwd del agente). */
  remoteRoot: string;
  /** Raíz del proyecto en la máquina local. */
  localRoot: string;
  localSep: string;
  hub: ToolBridgeHub;
  log: (msg: string) => void;
}

type JsonRpc = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => undefined); // evita rechazos no manejados si nadie lo espera
  return { promise, resolve, reject };
}

/**
 * Conecta un WebSocket (lado CLI) con el proceso del adaptador ACP (lado
 * proveedor). Es un puente de mensajes JSON-RPC con tres responsabilidades:
 *
 * 1. Traducción de rutas
 *      CLI → agente : rutas locales     → workspace espejo
 *      agente → CLI : workspace espejo  → rutas locales
 *
 * 2. Puente de herramientas: en session/new|load|resume inyecta un servidor MCP
 *    del daemon y el `_meta` del preset (que desactiva las herramientas internas
 *    del agente). Las llamadas a ese servidor se convierten en peticiones ACP
 *    hacia el CLI, que las ejecuta en la máquina local.
 *
 * 3. Multiplexación: las peticiones propias del daemon al CLI usan ids
 *    "relay-N" y sus respuestas se consumen aquí, sin llegar al agente.
 *
 * Toda llamada al proveedor de IA sale de este proceso hijo, en el daemon.
 */
export function bridgeSession(opts: BridgeOptions): ChildProcessWithoutNullStreams {
  const { ws, provider, providerName, remoteRoot, localRoot, localSep, hub, log } = opts;

  const baseEnv = { ...process.env, ...provider.env };
  const presetEnv = provider.toolBridge.enabled ? presetSpawnEnv(provider.toolBridge.preset, remoteRoot, baseEnv) : {};
  const child = spawn(provider.command, provider.args, {
    cwd: remoteRoot,
    env: { ...baseEnv, ...presetEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  log(`agente "${providerName}" iniciado (pid ${child.pid}) en ${remoteRoot}`);

  const toAgent = (msg: JsonRpc): JsonRpc => rewritePathPrefix(msg, localRoot, remoteRoot, localSep, "/");
  const toClient = (msg: JsonRpc): JsonRpc => rewritePathPrefix(msg, remoteRoot, localRoot, "/", localSep);

  const sendToClient = (msg: JsonRpc) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendToAgent = (msg: JsonRpc) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + "\n");
  };

  // ── Peticiones del daemon al CLI ───────────────────────────────────────────
  let nextId = 1;
  const pending = new Map<string, { d: Deferred<unknown>; timer: NodeJS.Timeout }>();
  const requester: ClientRequester = {
    request<T>(method: string, params: Record<string, unknown>, timeoutMs = CLIENT_REQUEST_TIMEOUT_MS) {
      const id = `relay-${nextId++}`;
      const d = deferred<unknown>();
      const timer = setTimeout(() => {
        pending.delete(id);
        d.reject(new Error(`el CLI no respondió ${method} a tiempo`));
      }, timeoutMs);
      pending.set(id, { d, timer });
      sendToClient({ jsonrpc: "2.0", id, method, params });
      return d.promise as Promise<T>;
    },
  };

  // ── Estado del puente de herramientas ──────────────────────────────────────
  const bridge = provider.toolBridge;
  const bridgeMeta = deepMerge(presetSessionMeta(bridge.preset), bridge.sessionMeta) as Record<string, unknown>;
  let agentSupportsHttpMcp: boolean | undefined;
  const initializeIds = new Set<string | number>();
  const newSessionWaiters = new Map<string | number, Deferred<string>>();
  const registeredKeys: string[] = [];
  let warnedNoHttp = false;

  const injectBridge = (msg: JsonRpc) => {
    if (!bridge.enabled || !msg.params || msg.id == null) return;
    if (agentSupportsHttpMcp === false) {
      if (!warnedNoHttp) log("aviso: el agente no anuncia MCP por HTTP; el puente de herramientas queda desactivado");
      warnedNoHttp = true;
      return;
    }

    const sessionId = deferred<string>();
    if (msg.method === "session/new") newSessionWaiters.set(msg.id, sessionId);
    else if (typeof msg.params.sessionId === "string") sessionId.resolve(msg.params.sessionId);

    const { key, url } = hub.register({ requester, sessionId: sessionId.promise, remoteRoot, localRoot, localSep, log });
    registeredKeys.push(key);

    const servers = Array.isArray(msg.params.mcpServers) ? (msg.params.mcpServers as Array<{ name?: string }>) : [];
    msg.params.mcpServers = [
      ...servers.filter((s) => s.name !== BRIDGE_SERVER_NAME),
      { type: "http", name: BRIDGE_SERVER_NAME, url, headers: [] },
    ];
    msg.params._meta = deepMerge(msg.params._meta ?? {}, bridgeMeta) as Record<string, unknown>;
    log(`puente de herramientas activo para ${msg.method} (preset ${bridge.preset})`);
  };

  // ── agente → CLI ───────────────────────────────────────────────────────────
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[${providerName} stdout no-JSON] ${line}`);
      return;
    }

    if (msg.id != null && msg.method === undefined) {
      if (initializeIds.delete(msg.id)) {
        const caps = msg.result?.agentCapabilities as { mcpCapabilities?: { http?: boolean } } | undefined;
        agentSupportsHttpMcp = caps?.mcpCapabilities?.http === true;
      }
      const waiter = newSessionWaiters.get(msg.id);
      if (waiter) {
        newSessionWaiters.delete(msg.id);
        const sid = msg.result?.sessionId;
        if (typeof sid === "string") waiter.resolve(sid);
        else waiter.reject(new Error(msg.error?.message ?? "session/new sin sessionId"));
      }
    }

    traceDelegation(msg, log);
    sendToClient(toClient(msg));
  });

  // El stderr de los adaptadores es muy ruidoso (tiempos, eventos internos):
  // solo se muestran errores y avisos, salvo con RELAY_DEBUG=1.
  const verbose = Boolean(process.env.RELAY_DEBUG);
  createInterface({ input: child.stderr }).on("line", (line) => {
    if (verbose || /\b(error|fail(ed)?|fatal|warn(ing)?|exception|denied|unauthorized|login)\b/i.test(line)) {
      log(`agente: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
    }
  });

  // ── CLI → agente ───────────────────────────────────────────────────────────
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log("frame no-JSON del cliente descartado");
      return;
    }

    // Respuesta a una petición propia del daemon: se queda aquí.
    if (typeof msg.id === "string" && msg.method === undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.d.reject(new Error(msg.error.message));
      else p.d.resolve(msg.result ?? {});
      return;
    }

    const out = toAgent(msg);
    if (out.method === "initialize" && out.id != null) initializeIds.add(out.id);
    if (out.method && SESSION_METHODS.has(out.method)) injectBridge(out);
    sendToAgent(out);
  });

  const cleanup = () => {
    for (const key of registeredKeys) hub.unregister(key);
    for (const { d, timer } of pending.values()) {
      clearTimeout(timer);
      d.reject(new Error("conexión con el CLI cerrada"));
    }
    pending.clear();
  };

  const shutdown = (reason: string) => {
    cleanup();
    if (child.exitCode === null && !child.killed) {
      log(`deteniendo agente "${providerName}": ${reason}`);
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
    }
  };

  ws.on("close", () => shutdown("el cliente cerró la conexión"));
  ws.on("error", (err) => shutdown(`error de WebSocket: ${err.message}`));

  child.on("error", (err) => {
    log(`no se pudo iniciar el agente "${providerName}": ${err.message}`);
    if (ws.readyState === ws.OPEN) ws.close(1011, "agent-spawn-failed");
  });
  child.on("exit", (code, signal) => {
    cleanup();
    log(`agente "${providerName}" terminó (code=${code}, signal=${signal})`);
    if (ws.readyState === ws.OPEN) ws.close(1000, "agent-exited");
  });

  return child;
}

/** Registra en el log qué operaciones delega el agente al cliente por ACP. */
function traceDelegation(msg: JsonRpc, log: (m: string) => void) {
  if (msg.id != null && typeof msg.method === "string" && (msg.method.startsWith("fs/") || msg.method.startsWith("terminal/"))) {
    log(`→ delegado al cliente por ACP: ${msg.method}`);
  }
}
