import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { WebSocket } from "ws";
import { rewritePathPrefix } from "../shared/protocol.js";
import type { ProviderConfig } from "./config.js";

export interface BridgeOptions {
  ws: WebSocket;
  providerName: string;
  provider: ProviderConfig;
  /** Workspace espejo en la máquina remota (cwd del agente). */
  remoteRoot: string;
  /** Raíz del proyecto en la máquina local. */
  localRoot: string;
  localSep: string;
  log: (msg: string) => void;
}

/**
 * Conecta un WebSocket (lado CLI) con el proceso del adaptador ACP (lado
 * proveedor). Es un puente de mensajes JSON-RPC con traducción de rutas:
 *
 *   CLI → agente : rutas locales  → workspace espejo
 *   agente → CLI : workspace espejo → rutas locales
 *
 * Así el agente "cree" que trabaja en el workspace espejo, pero cada
 * fs/read_text_file, fs/write_text_file o terminal/create que delega al
 * cliente llega al CLI con la ruta real de tu máquina.
 *
 * Toda llamada al proveedor de IA sale de este proceso hijo, en el daemon.
 */
export function bridgeSession(opts: BridgeOptions): ChildProcessWithoutNullStreams {
  const { ws, provider, providerName, remoteRoot, localRoot, localSep, log } = opts;

  const child = spawn(provider.command, provider.args, {
    cwd: remoteRoot,
    env: { ...process.env, ...provider.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  log(`agente "${providerName}" iniciado (pid ${child.pid}) en ${remoteRoot}`);

  const toAgent = (msg: unknown) => rewritePathPrefix(msg, localRoot, remoteRoot, localSep, "/");
  const toClient = (msg: unknown) => rewritePathPrefix(msg, remoteRoot, localRoot, "/", localSep);

  // agente → CLI
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[${providerName} stdout no-JSON] ${line}`);
      return;
    }
    traceDelegation(msg, log);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(toClient(msg)));
  });

  createInterface({ input: child.stderr }).on("line", (line) => log(`[${providerName}] ${line}`));

  // CLI → agente
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log("frame no-JSON del cliente descartado");
      return;
    }
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify(toAgent(msg)) + "\n");
  });

  const shutdown = (reason: string) => {
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
    log(`agente "${providerName}" terminó (code=${code}, signal=${signal})`);
    if (ws.readyState === ws.OPEN) ws.close(1000, "agent-exited");
  });

  return child;
}

/** Registra en el log qué operaciones delega el agente al cliente (disco local). */
function traceDelegation(msg: unknown, log: (m: string) => void) {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { method?: string; id?: unknown };
  if (m.id !== undefined && typeof m.method === "string" && (m.method.startsWith("fs/") || m.method.startsWith("terminal/"))) {
    log(`→ delegado al cliente: ${m.method}`);
  }
}
