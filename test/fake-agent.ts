/**
 * Agente ACP falso para pruebas. Simula un proveedor que corre en la máquina
 * remota y, en cada prompt:
 *   - revisa que AGENTS.md y las skills estén en SU workspace (remoto),
 *   - lee README.md, escribe salida.txt y ejecuta `pwd` delegando al cliente,
 *   - responde con un reporte de lo que observó.
 */
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, RequestError, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

let sessionCwd = "";
let mcpUrl: string | undefined;
let sessionMeta: Record<string, unknown> = {};

/** Cliente MCP mínimo (Streamable HTTP, respuestas JSON) para probar el puente. */
let mcpId = 0;
async function mcp(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(mcpUrl!, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method, params }),
  });
  const body = (await res.json()) as { result?: any; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
async function tool(name: string, args: Record<string, unknown>) {
  const r = await mcp("tools/call", { name, arguments: args });
  return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join(""), isError: r.isError === true };
}

async function bridgeReport(): Promise<string[]> {
  const out: string[] = [];
  const meta = sessionMeta as { claudeCode?: { options?: { disallowedTools?: string[]; allowedTools?: string[] } } };
  out.push(`MCP_URL=${mcpUrl ? new URL(mcpUrl).hostname : "no"}`);
  out.push(`DISALLOWED_READ=${meta.claudeCode?.options?.disallowedTools?.includes("Read") ? "si" : "no"}`);
  out.push(`ALLOWED=${(meta.claudeCode?.options?.allowedTools ?? []).join(",")}`);
  if (!mcpUrl) return out;

  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
  const tools = await mcp("tools/list");
  out.push(`TOOLS=${(tools.tools as Array<{ name: string }>).map((t) => t.name).sort().join(",")}`);

  // Ruta relativa y ruta absoluta del espejo: ambas deben llegar al disco local.
  out.push(`B_READ=${JSON.stringify((await tool("read", { path: "README.md" })).text)}`);
  out.push(`B_READ_ABS=${JSON.stringify((await tool("read", { path: path.join(sessionCwd, "README.md") })).text)}`);
  out.push(`B_READ_ALIAS=${JSON.stringify((await tool("read", { file_path: path.join(sessionCwd, "README.md") })).text)}`);
  out.push(`B_READ_SIN_RUTA=${(await tool("read", {})).isError ? "error" : "ok"}`);
  out.push(`B_WRITE=${(await tool("write", { path: "src/nuevo.ts", content: "export const a = 1;\nexport const b = 1;\n" })).isError ? "error" : "ok"}`);
  out.push(`B_EDIT_AMBIGUO=${(await tool("edit", { path: "src/nuevo.ts", old_string: "= 1", new_string: "= 2" })).isError ? "error" : "ok"}`);
  out.push(`B_EDIT=${(await tool("edit", { path: "src/nuevo.ts", old_string: "const b = 1", new_string: "const b = 2" })).isError ? "error" : "ok"}`);
  out.push(`B_PWD=${(await tool("bash", { command: "pwd && echo hecho > marca.txt" })).text.split("\n")[0]}`);
  out.push(`B_EXIT=${JSON.stringify((await tool("bash", { command: "exit 3" })).text)}`);
  out.push(`B_GREP=${JSON.stringify((await tool("grep", { pattern: "const b", glob: "*.ts" })).text)}`);
  out.push(`B_GLOB=${JSON.stringify((await tool("glob", { pattern: "**/*.ts" })).text)}`);
  const outside = await tool("read", { path: "/etc/hostname" });
  out.push(`B_FUERA=${outside.isError ? "denegado" : "permitido"}`);
  return out;
}

// Sesiones persistentes en el workspace espejo, como los agentes reales: sobreviven
// a que el daemon reinicie el proceso del agente.
interface StoredSession {
  cwd: string;
  title: string | null;
  updatedAt: string;
  history: Array<{ user: string; agent: string }>;
}
const storeFile = () => path.join(process.cwd(), ".fake-sessions.json");
const loadStore = (): Record<string, StoredSession> => {
  try {
    return JSON.parse(readFileSync(storeFile(), "utf8"));
  } catch {
    return {};
  }
};
const saveStore = (s: Record<string, StoredSession>) => writeFileSync(storeFile(), JSON.stringify(s, null, 2));

function attach(params: { cwd: string; mcpServers?: Array<{ name: string } & Record<string, unknown>>; _meta?: unknown }) {
  sessionCwd = params.cwd;
  const relay = (params.mcpServers ?? []).find((s) => s.name === "relay");
  mcpUrl = relay && typeof relay.url === "string" ? relay.url : undefined;
  sessionMeta = (params._meta ?? {}) as Record<string, unknown>;
}

const app = agent({ name: "fake-agent" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, sessionCapabilities: { list: {}, resume: {} } },
    agentInfo: { name: "fake-agent", version: "0.0.1" },
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    attach(params);
    const sessionId = `ses-${Math.random().toString(16).slice(2, 10)}`;
    const store = loadStore();
    store[sessionId] = { cwd: params.cwd, title: null, updatedAt: new Date().toISOString(), history: [] };
    saveStore(store);
    return { sessionId };
  })
  .onRequest(methods.agent.session.list, ({ params }) => ({
    sessions: Object.entries(loadStore())
      .filter(([, s]) => !params.cwd || s.cwd === params.cwd)
      .map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })),
  }))
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    const stored = loadStore()[params.sessionId];
    if (!stored) throw RequestError.resourceNotFound(params.sessionId);
    attach(params);
    for (const h of stored.history) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: h.user } },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: h.agent } },
      });
    }
    return {};
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    if (!loadStore()[params.sessionId]) throw RequestError.resourceNotFound(params.sessionId);
    attach(params);
    return {};
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const report: string[] = [];
    const say = (text: string) =>
      client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });

    const promptText = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}:${"uri" in b ? b.uri : ""}]`)).join(" ");

    if (promptText.startsWith("MUERE")) process.exit(3); // simula que el agente se cae a mitad de turno
    if (promptText.startsWith("ECO ")) {
      const store = loadStore();
      const stored = store[params.sessionId];
      const text = promptText.slice(4);
      const reply = `eco: ${text} (historial: ${(stored?.history.length ?? 0) + 1})`;
      if (stored) {
        stored.history.push({ user: promptText, agent: reply });
        if (!stored.title) {
          stored.title = `Sesión de ${text}`;
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: "session_info_update", title: stored.title },
          });
        }
        stored.updatedAt = new Date().toISOString();
        saveStore(store);
      }
      await say(`${reply}\n`);
      return { stopReason: "end_turn" };
    }

    if (promptText.startsWith("PUENTE")) {
      const lines = await bridgeReport();
      writeFileSync(path.join(process.cwd(), ".fake-report"), lines.join("\n") + "\n");
      await say(lines.join("\n") + "\n");
      return { stopReason: "end_turn" };
    }
    report.push(`PROMPT=${promptText}`);
    report.push(`CWD_AGENTE=${sessionCwd}`);
    report.push(`PROCESS_CWD=${process.cwd()}`);
    report.push(`AGENTS_REMOTO=${existsSync(path.join(sessionCwd, "AGENTS.md")) ? "si" : "no"}`);
    report.push(`ALIAS_CLAUDE=${existsSync(path.join(sessionCwd, "CLAUDE.md")) ? readFileSync(path.join(sessionCwd, "CLAUDE.md"), "utf8").trim() : "no"}`);
    const link = path.join(sessionCwd, ".claude", "skills");
    report.push(`SKILLS_ENLAZADAS=${existsSync(link) && lstatSync(link).isSymbolicLink() && existsSync(path.join(link, "demo", "SKILL.md")) ? "si" : "no"}`);
    report.push(`CREDENCIAL=${process.env.FAKE_PROVIDER_KEY ? "presente" : "ausente"}`);

    const readme = await client.request(methods.client.fs.readTextFile, {
      sessionId: params.sessionId,
      path: path.join(sessionCwd, "README.md"),
    });
    report.push(`README=${readme.content.trim()}`);

    const perm = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "w1", title: "Escribir salida.txt" },
      options: [
        { optionId: "ok", name: "Permitir", kind: "allow_once" },
        { optionId: "no", name: "Rechazar", kind: "reject_once" },
      ],
    });
    const allowed = perm.outcome.outcome === "selected" && perm.outcome.optionId === "ok";
    report.push(`PERMISO=${allowed ? "si" : "no"}`);
    if (allowed) {
      await client.request(methods.client.fs.writeTextFile, {
        sessionId: params.sessionId,
        path: path.join(sessionCwd, "salida.txt"),
        content: "escrito por el agente remoto\n",
      });
    }

    const term = await client.createTerminal({
      sessionId: params.sessionId,
      command: "pwd",
      cwd: sessionCwd,
    });
    await term.waitForExit();
    const out = await term.currentOutput();
    await term.release();
    report.push(`PWD_TERMINAL=${out.output.trim()}`);

    try {
      await client.request(methods.client.fs.readTextFile, { sessionId: params.sessionId, path: "/etc/hostname" });
      report.push("FUERA_DEL_PROYECTO=permitido");
    } catch {
      report.push("FUERA_DEL_PROYECTO=denegado");
    }

    // El reporte crudo queda en el disco remoto: allí se ven las rutas reales
    // del espejo. El mensaje que viaja al cliente pasa por la traducción de rutas.
    writeFileSync(path.join(process.cwd(), ".fake-report"), report.join("\n") + "\n");
    await say(report.join("\n") + "\n");
    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
const conn = app.connect(stream);
await conn.closed;
