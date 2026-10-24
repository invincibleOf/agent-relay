#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  type ClientConnection,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import { packageVersion } from "../shared/version.js";
import { INIT_PROMPT, expandTemplate, loadCustomCommands } from "./commands.js";
import { defaultCliConfigPath, loadCliConfig, resolveHost } from "./config.js";
import { LocalTools } from "./local-tools.js";
import { collectProjectFiles, findProjectRoot, projectId } from "./project.js";
import { Renderer, color } from "./render.js";
import { connectRelay } from "./transport.js";

const HELP = `relay ${packageVersion()} — agentes de código remotos que trabajan sobre tu máquina

Uso:
  relay [opciones]                 Sesión interactiva
  relay [opciones] -p "<prompt>"   Un solo prompt y salir
  relay doctor [opciones]          Verifica conexión con el daemon y el agente

Opciones:
  -H, --host <nombre>     Host definido en ${defaultCliConfigPath()}
  -a, --agent <nombre>    Proveedor en el daemon (claude, codex, opencode…)
      --url <ws(s)://…>   Conexión directa (requiere RELAY_TOKEN)
  -p, --print <prompt>    Modo no interactivo
  -y, --yes               Aprueba automáticamente los permisos que pida el agente
      --cwd <ruta>        Carpeta del proyecto (por defecto la actual)
      --thoughts          Muestra el razonamiento del agente si lo envía
  -c, --config <ruta>     Archivo de configuración del CLI
  -v, --version
  -h, --help

Comandos en la sesión: escribe /help
`;

const BUILTIN_HELP = `Comandos:
  /help                 Esta ayuda
  /new                  Nueva sesión con el agente
  /init                 Crea o mejora AGENTS.md (formato abierto)
  /commands             Lista comandos personalizados y del agente
  /modes                Lista modos del agente
  /mode <id>            Cambia de modo
  /status               Host, proveedor y workspace remoto
  /exit                 Salir
  Ctrl+C                Cancela el turno en curso (dos veces para salir)
  @ruta/archivo         Adjunta un archivo local como referencia
Cualquier otro /comando se busca en .agents/commands/ o se envía al agente.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string", short: "H" },
      agent: { type: "string", short: "a" },
      url: { type: "string" },
      print: { type: "string", short: "p" },
      yes: { type: "boolean", short: "y" },
      cwd: { type: "string" },
      thoughts: { type: "boolean" },
      config: { type: "string", short: "c" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${packageVersion()}\n`);

  const subcommand = positionals[0];
  const cfg = loadCliConfig(values.config ?? defaultCliConfigPath());
  const host = resolveHost(cfg, values.host, values.url);
  const autoApprove = values.yes ?? cfg.permissions.autoApprove;

  const root = findProjectRoot(values.cwd ?? process.cwd());
  const { files, warnings } = collectProjectFiles(root);

  const renderer = new Renderer(values.thoughts ?? false);
  const tools = new LocalTools(root, cfg.permissions.extraRoots, (k, d) => renderer.local(k, d));
  const interactive = values.print === undefined && subcommand !== "doctor";

  for (const w of warnings) renderer.line(color.yellow(`aviso: ${w}`));

  const relay = await connectRelay({ host, provider: values.agent, project: { root, id: projectId(root), files } });

  renderer.line(
    color.bold(`relay → ${relay.ready.daemon.hostname}`) +
      color.dim(` · host ${host.name} · proveedor ${relay.ready.provider} · consumo de IA en el daemon`),
  );
  renderer.line(color.dim(`proyecto ${root} · ${files.length} archivo(s) en formato abierto sincronizados`));

  let rl: Interface | undefined;
  const ask = async (q: string) => {
    if (!rl) throw new Error("sin terminal interactiva");
    return rl.question(q);
  };

  const app = client({ name: "agent-relay" })
    .onRequest(methods.client.fs.readTextFile, ({ params }) => tools.readTextFile(params))
    .onRequest(methods.client.fs.writeTextFile, ({ params }) => tools.writeTextFile(params))
    .onRequest(methods.client.terminal.create, ({ params }) => tools.createTerminal(params))
    .onRequest(methods.client.terminal.output, ({ params }) => tools.terminalOutput(params))
    .onRequest(methods.client.terminal.waitForExit, ({ params }) => tools.waitForExit(params))
    .onRequest(methods.client.terminal.kill, ({ params }) => tools.kill(params))
    .onRequest(methods.client.terminal.release, ({ params }) => tools.release(params))
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      requestPermission(params, { autoApprove, interactive, ask, renderer }),
    )
    .onNotification(methods.client.session.update, ({ params }) => renderer.update(params));

  const acp = app.connect(relay.stream);
  relay.closed.then(({ code, reason }) => {
    tools.disposeAll();
    if (code !== 1000 || reason) renderer.line(color.yellow(`conexión con el daemon cerrada (${code}${reason ? ` ${reason}` : ""})`));
    acp.close();
  });

  const init = await acp.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "agent-relay", title: "agent-relay CLI", version: packageVersion() },
  });

  if (subcommand === "doctor") {
    renderer.line(`agente: ${init.agentInfo?.name ?? "?"} ${init.agentInfo?.version ?? ""}`);
    renderer.line(`protocolo ACP: v${init.protocolVersion}`);
    renderer.line(`workspace espejo: ${relay.ready.remoteWorkspace}`);
    renderer.line(`proveedores en el daemon: ${relay.ready.availableProviders.join(", ")}`);
    const localKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY"].filter((k) => process.env[k]);
    if (localKeys.length) {
      renderer.line(color.yellow(`nota: ${localKeys.join(", ")} definidas aquí; relay no las usa, el consumo ocurre en el daemon.`));
    }
    relay.close();
    return;
  }

  let session = await newSession(acp, root, renderer);

  if (!interactive) {
    const stop = await runTurn(acp, session.id, buildPrompt(values.print ?? "", process.cwd()), renderer);
    renderer.newline();
    relay.close();
    process.exitCode = stop === "error" ? 1 : 0;
    return;
  }

  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let turnActive = false;
  let lastSigint = 0;
  rl.on("SIGINT", () => {
    if (turnActive) {
      renderer.line(color.yellow("cancelando turno…"));
      void acp.agent.notify(methods.agent.session.cancel, { sessionId: session.id });
      return;
    }
    if (Date.now() - lastSigint < 1500) {
      rl?.close();
      relay.close();
      process.exit(0);
    }
    lastSigint = Date.now();
    renderer.line(color.dim("(Ctrl+C otra vez para salir)"));
  });

  renderer.line(color.dim("Escribe tu mensaje, /help para ver comandos."));
  const commands = () => loadCustomCommands(root);

  for (;;) {
    let input: string;
    try {
      input = (await rl.question(color.bold("\n› "))).trim();
    } catch {
      break; // stdin cerrado
    }
    if (!input) continue;

    let promptText = input;
    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(" ");
      const args = rest.join(" ");
      switch (cmd) {
        case "exit":
        case "quit":
          rl.close();
          relay.close();
          return;
        case "help":
          renderer.line(BUILTIN_HELP);
          continue;
        case "new":
          session = await newSession(acp, root, renderer);
          continue;
        case "status":
          renderer.line(
            `host: ${host.name} (${host.url})\nproveedor: ${relay.ready.provider} — ${init.agentInfo?.name ?? "?"} ${init.agentInfo?.version ?? ""}\n` +
              `daemon: ${relay.ready.daemon.hostname} v${relay.ready.daemon.version}\nworkspace espejo: ${relay.ready.remoteWorkspace}\n` +
              `sesión: ${session.id}${renderer.currentMode ? `\nmodo: ${renderer.currentMode}` : ""}`,
          );
          continue;
        case "modes":
          renderModes(session.modes, renderer);
          continue;
        case "mode":
          if (!args) {
            renderModes(session.modes, renderer);
            continue;
          }
          try {
            await acp.agent.request(methods.agent.session.setMode, { sessionId: session.id, modeId: args.trim() });
            renderer.currentMode = args.trim();
            renderer.line(color.dim(`modo: ${args.trim()}`));
          } catch (err) {
            renderer.line(color.red(`no se pudo cambiar de modo: ${(err as Error).message}`));
          }
          continue;
        case "commands": {
          const custom = [...commands().values()];
          renderer.line(color.bold("Personalizados (.agents/commands):"));
          if (!custom.length) renderer.line(color.dim("  (ninguno)"));
          for (const c of custom) renderer.line(`  /${c.name}  ${color.dim(`${c.description} [${c.source}]`)}`);
          renderer.line(color.bold(`Del agente (${relay.ready.provider}):`));
          if (!renderer.availableCommands.length) renderer.line(color.dim("  (ninguno anunciado)"));
          for (const c of renderer.availableCommands) renderer.line(`  /${c.name}  ${color.dim(c.description)}`);
          continue;
        }
        case "init":
          promptText = INIT_PROMPT + (args ? `\n\nIndicaciones adicionales: ${args}` : "");
          break;
        default: {
          const custom = commands().get(cmd);
          if (custom) promptText = expandTemplate(custom.template, args);
          // si no, se envía tal cual: puede ser un comando del propio agente
        }
      }
    }

    turnActive = true;
    try {
      await runTurn(acp, session.id, buildPrompt(promptText, process.cwd()), renderer);
    } finally {
      turnActive = false;
    }
  }

  relay.close();
}

async function newSession(acp: ClientConnection, root: string, renderer: Renderer) {
  try {
    const res = await acp.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    if (res.modes?.currentModeId) renderer.currentMode = res.modes.currentModeId;
    return { id: res.sessionId, modes: res.modes ?? null };
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === -32000) {
      throw new Error(
        "El agente necesita iniciar sesión en la máquina REMOTA (las credenciales viven en el daemon). " +
          "Entra a esa máquina y haz el login del proveedor (p. ej. `claude` → /login, `codex login`, `opencode auth login`).",
      );
    }
    throw err;
  }
}

async function runTurn(acp: ClientConnection, sessionId: string, prompt: ContentBlock[], renderer: Renderer) {
  try {
    const res = await acp.agent.request(methods.agent.session.prompt, { sessionId, prompt });
    renderer.newline();
    if (res.stopReason !== "end_turn") renderer.line(color.dim(`(fin del turno: ${res.stopReason})`));
    return res.stopReason;
  } catch (err) {
    renderer.line(color.red(`error: ${(err as Error).message}`));
    return "error" as const;
  }
}

/** Convierte el texto en bloques ACP; cada @archivo existente se adjunta como resource_link. */
function buildPrompt(text: string, cwd: string): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text }];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const abs = path.resolve(cwd, m[1]);
    if (seen.has(abs) || !existsSync(abs) || !statSync(abs).isFile()) continue;
    seen.add(abs);
    blocks.push({ type: "resource_link", name: path.basename(abs), uri: `file://${abs}` });
  }
  return blocks;
}

function renderModes(modes: SessionModeState | null, renderer: Renderer) {
  if (!modes?.availableModes?.length) {
    renderer.line(color.dim("El agente no anunció modos."));
    return;
  }
  for (const m of modes.availableModes) {
    const current = m.id === (renderer.currentMode ?? modes.currentModeId) ? color.green(" ← actual") : "";
    renderer.line(`  ${m.id}  ${color.dim(m.name)}${current}`);
  }
}

async function requestPermission(
  req: RequestPermissionRequest,
  ctx: { autoApprove: boolean; interactive: boolean; ask: (q: string) => Promise<string>; renderer: Renderer },
): Promise<RequestPermissionResponse> {
  const { renderer } = ctx;
  const title = req.toolCall.title ?? req.toolCall.toolCallId;
  const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind === "allow_always");
  const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");

  if (ctx.autoApprove && allow) {
    renderer.line(color.dim(`  permiso aprobado automáticamente: ${title}`));
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  if (!ctx.interactive) {
    renderer.line(color.yellow(`  permiso denegado (modo no interactivo, usa --yes): ${title}`));
    return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  renderer.line(color.yellow(`? El agente pide permiso: ${title}`));
  req.options.forEach((o, i) => renderer.line(`  ${i + 1}) ${o.name} ${color.dim(`[${o.kind}]`)}`));
  for (;;) {
    const answer = (await ctx.ask("  elige una opción: ")).trim();
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && req.options[idx]) {
      return { outcome: { outcome: "selected", optionId: req.options[idx].optionId } };
    }
    if (answer === "") return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
  }
}

main().catch((err) => {
  process.stderr.write(`${color.red("relay:")} ${(err as Error).message}\n`);
  process.exit(1);
});
