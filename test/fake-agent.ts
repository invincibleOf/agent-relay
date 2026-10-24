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
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

let sessionCwd = "";

const app = agent({ name: "fake-agent" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "fake-agent", version: "0.0.1" },
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    sessionCwd = params.cwd;
    return { sessionId: "fake-session-1" };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const report: string[] = [];
    const say = (text: string) =>
      client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });

    const promptText = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}:${"uri" in b ? b.uri : ""}]`)).join(" ");
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
