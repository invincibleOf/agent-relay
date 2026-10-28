#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { ProjectFile, ReadyFrame } from "../shared/protocol.js";
import { box, rows, termWidth, tildify, truncate, truncateStart, visibleWidth } from "../shared/ui.js";
import { packageVersion } from "../shared/version.js";
import { INIT_PROMPT, expandTemplate, loadCustomCommands } from "./commands.js";
import { configDir, defaultCliConfigPath, loadCliConfig, resolveHost, type ResolvedHost } from "./config.js";
import { InputEditor } from "./input.js";
import { LocalTools } from "./local-tools.js";
import { collectProjectFiles, findProjectRoot, projectId } from "./project.js";
import { Renderer, st } from "./render.js";
import { connectRelay } from "./transport.js";

const HELP = `${st.bold(st.accent("◆ agent-relay"))} ${st.gray(`v${packageVersion()}`)}
Agentes de código que corren en otra máquina y trabajan sobre tu proyecto local.

${st.bold("Uso")}
  relay [opciones]                 Sesión interactiva
  relay [opciones] -p "<prompt>"   Un solo prompt y salir
  relay doctor [opciones]          Verifica conexión, agente, puente y ripgrep

${st.bold("Opciones")}
  -H, --host <nombre>     Host definido en ${tildify(defaultCliConfigPath())}
  -a, --agent <nombre>    Proveedor en el daemon (claude, codex, opencode…)
      --url <ws(s)://…>   Conexión directa (requiere RELAY_TOKEN)
  -p, --print <prompt>    Modo no interactivo
  -y, --yes               Aprueba automáticamente los permisos que pida el agente
      --cwd <ruta>        Carpeta del proyecto (por defecto la actual)
      --thoughts          Muestra el razonamiento del agente si lo envía
  -c, --config <ruta>     Archivo de configuración del CLI
  -v, --version
  -h, --help

Dentro de la sesión escribe ${st.cyan("/help")} para ver los comandos.
`;

const BUILTIN_COMMANDS: Array<[string, string]> = [
  ["/help", "Esta ayuda"],
  ["/new", "Nueva sesión con el agente"],
  ["/init", "Crea o mejora AGENTS.md (formato abierto)"],
  ["/model [id]", "Muestra o cambia el modelo"],
  ["/mode [id]", "Muestra o cambia el modo del agente"],
  ["/commands", "Comandos personalizados y del agente"],
  ["/status", "Conexión, agente, puente y sesión"],
  ["/clear", "Limpia la pantalla"],
  ["/exit", "Salir"],
];

interface Context {
  host: ResolvedHost;
  ready: ReadyFrame;
  init: InitializeResponse;
  root: string;
  files: ProjectFile[];
  renderer: Renderer;
}

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
  const isDoctor = subcommand === "doctor";
  const interactive = values.print === undefined && !isDoctor;
  const cfg = loadCliConfig(values.config ?? defaultCliConfigPath());
  const host = resolveHost(cfg, values.host, values.url);
  const autoApprove = values.yes ?? cfg.permissions.autoApprove;

  const root = findProjectRoot(values.cwd ?? process.cwd());
  const { files, warnings: projectWarnings } = collectProjectFiles(root);

  const renderer = new Renderer(values.thoughts ?? false);
  const tools = new LocalTools(root, cfg.permissions.extraRoots, (k, d) => renderer.local(k, d));

  if (interactive) process.stdout.write(st.gray(`  conectando con ${host.url}…\r`));
  const relay = await connectRelay({ host, provider: values.agent, project: { root, id: projectId(root), files } });
  if (interactive) process.stdout.write("\x1b[2K");

  // En una terminal se usa el editor propio (pegado de varias líneas, historial);
  // si la entrada viene de una tubería, readline línea por línea.
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const editor = interactive && tty ? new InputEditor(process.stdin, process.stdout, st, path.join(configDir(), "history.json")) : undefined;
  let fallback: Interface | undefined;
  const readInput = async (prompt: string, multiline: boolean, history: boolean): Promise<string> => {
    if (editor) return editor.read({ prompt, multiline, history });
    fallback ??= createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    return fallback.question(prompt);
  };
  const ask = (q: string) => readInput(q, false, false);

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
    if (code !== 1000 || reason) renderer.line(st.yellow(`  ! conexión con el daemon cerrada (${code}${reason ? ` ${reason}` : ""})`));
    acp.close();
  });

  const init = await acp.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "agent-relay", title: "agent-relay CLI", version: packageVersion() },
  });

  const ctx: Context = { host, ready: relay.ready, init, root, files, renderer };
  const warnings = [...projectWarnings, ...connectionWarnings(ctx)];

  if (isDoctor) {
    printDoctor(ctx, warnings);
    relay.close();
    return;
  }

  let session = await newSession(acp, root, renderer);

  if (!interactive) {
    // En modo -p la salida estándar queda para la respuesta; el encabezado va a stderr.
    process.stderr.write(st.gray(`agent-relay v${packageVersion()} · ${relay.ready.provider} en ${relay.ready.daemon.hostname}\n`));
    for (const w of warnings) process.stderr.write(st.yellow(`! ${w}\n`));
    const stop = await runTurn(acp, session.id, buildPrompt(values.print ?? "", process.cwd()), renderer, false);
    renderer.newline();
    relay.close();
    process.exitCode = stop === "error" ? 1 : 0;
    return;
  }

  printBanner(ctx, session, warnings);

  let turnActive = false;
  let lastSigint = 0;
  const onInterrupt = () => {
    if (turnActive) {
      renderer.line(st.yellow("  cancelando…"));
      void acp.agent.notify(methods.agent.session.cancel, { sessionId: session.id });
      return;
    }
    if (Date.now() - lastSigint < 1500) {
      editor?.stop();
      relay.close();
      process.exit(0);
    }
    lastSigint = Date.now();
    renderer.line(st.gray("  (Ctrl+C otra vez para salir)"));
  };
  if (editor) {
    editor.start();
    editor.onInterrupt(onInterrupt); // Ctrl+C mientras el agente trabaja
  } else {
    process.on("SIGINT", onInterrupt);
  }

  const commands = () => loadCustomCommands(root);
  editor?.setCompletions(() => [
    ...BUILTIN_COMMANDS.map(([c]) => c.split(" ")[0]),
    ...[...commands().keys()].map((c) => `/${c}`),
    ...renderer.availableCommands.map((c) => `/${c.name}`),
  ]);

  for (;;) {
    let input: string;
    try {
      process.stdout.write("\n");
      input = (await readInput(`${st.accent("›")} `, true, true)).trim();
    } catch {
      break; // Ctrl+D, Ctrl+C dos veces o stdin cerrado
    }
    if (!input) continue;

    let promptText = input;
    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(" ");
      const args = rest.join(" ").trim();
      switch (cmd) {
        case "exit":
        case "quit":
          editor?.stop();
          fallback?.close();
          relay.close();
          return;
        case "help":
          printHelp(renderer, commands().size);
          continue;
        case "clear":
          process.stdout.write("\x1b[2J\x1b[H");
          continue;
        case "new":
          session = await newSession(acp, root, renderer);
          renderer.line(st.gray(`  nueva sesión ${session.id.slice(0, 8)}`));
          continue;
        case "status":
          renderer.line();
          for (const l of statusRows(ctx, session)) renderer.line(l);
          continue;
        case "modes":
        case "mode":
          if (!args) {
            renderModes(session.modes, renderer);
            continue;
          }
          try {
            await acp.agent.request(methods.agent.session.setMode, { sessionId: session.id, modeId: args });
            renderer.currentMode = args;
            renderer.line(st.gray(`  modo → ${args}`));
          } catch (err) {
            renderer.line(st.red(`  ✗ no se pudo cambiar de modo: ${(err as Error).message}`));
          }
          continue;
        case "model":
        case "models":
          await modelCommand(acp, session.id, args, renderer);
          continue;
        case "commands": {
          const custom = [...commands().values()];
          renderer.line();
          renderer.line(`  ${st.bold("Personalizados")} ${st.gray(".agents/commands")}`);
          if (!custom.length) renderer.line(st.gray("    (ninguno)"));
          for (const l of rows(custom.map((c) => [`/${c.name}`, `${c.description} ${st.gray(`[${c.source}]`)}`]), st, "    ")) renderer.line(l);
          renderer.line(`  ${st.bold("Del agente")} ${st.gray(relay.ready.provider)}`);
          if (!renderer.availableCommands.length) renderer.line(st.gray("    (ninguno anunciado)"));
          for (const l of rows(renderer.availableCommands.map((c) => [`/${c.name}`, st.gray(truncate(c.description, 70))]), st, "    ")) {
            renderer.line(l);
          }
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
      await runTurn(acp, session.id, buildPrompt(promptText, process.cwd()), renderer, true);
    } finally {
      turnActive = false;
    }
  }

  editor?.stop();
  fallback?.close();
  relay.close();
}

// ─── Presentación ────────────────────────────────────────────────────────────

const shortAgentName = (name?: string) => (name ?? "?").replace(/^@[^/]+\//, "");

function projectSummary(files: ProjectFile[], customCommands: number): string {
  const hasAgents = files.some((f) => f.path === "AGENTS.md");
  const skills = new Set(files.map((f) => /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(f.path)?.[1]).filter(Boolean)).size;
  const parts = [hasAgents ? `AGENTS.md ${st.green("✓")}` : st.gray("sin AGENTS.md (usa /init)")];
  if (skills) parts.push(`${skills} skill${skills === 1 ? "" : "s"}`);
  if (customCommands) parts.push(`${customCommands} comando${customCommands === 1 ? "" : "s"}`);
  return parts.join(st.gray(" · "));
}

function bridgeLabel(ready: ReadyFrame): string {
  const b = ready.toolBridge;
  const rg = ripgrepVersion();
  const rgText = rg ? st.gray(` · ${rg.replace(/^ripgrep\s+/, "ripgrep ")}`) : st.yellow(" · sin ripgrep");
  if (!b) return st.yellow("desconocido (daemon antiguo)");
  if (!b.enabled) return st.yellow("desactivado");
  if (b.preset === "none") return `${st.yellow("activo, sin preset")}${rgText}`;
  return `${st.green("✓")} activo ${st.gray(`· preset ${b.preset}`)}${rgText}`;
}

function printBanner(ctx: Context, session: { id: string; modes: SessionModeState | null }, warnings: string[]) {
  const { ready, init, host, root, files, renderer } = ctx;
  const title = [
    `${st.bold(st.accent("◆ agent-relay"))}  ${st.gray(`v${packageVersion()}`)}`,
    st.gray("agentes remotos · archivos y comandos en tu máquina"),
  ];
  process.stdout.write(`\n${box(title, st)}\n\n`);

  const model = renderer.configValue("model");
  const mode = renderer.currentMode ?? session.modes?.currentModeId;
  const entries: Array<[string, string]> = [
    ["daemon", `${st.bold(ready.daemon.hostname)} ${st.gray(`· v${ready.daemon.version} · ${host.name === "url" ? host.url : `${host.name} · ${host.url}`}`)}`],
    ["agente", `${st.bold(ready.provider)} ${st.gray(`· ${shortAgentName(init.agentInfo?.name)} ${init.agentInfo?.version ?? ""}`)}`],
  ];
  if (model || mode) entries.push(["modelo", [model, mode && st.gray(`modo ${mode}`)].filter(Boolean).join(st.gray(" · "))]);
  entries.push(["puente", bridgeLabel(ready)]);
  const summary = projectSummary(files, loadCustomCommands(root).size);
  const room = Math.max(20, termWidth() - 14 - visibleWidth(summary) - 3);
  entries.push(["proyecto", `${st.bold(truncateStart(tildify(root), room))} ${st.gray("·")} ${summary}`]);
  for (const l of rows(entries, st)) process.stdout.write(`${l}\n`);

  if (warnings.length) process.stdout.write("\n");
  for (const w of warnings) process.stdout.write(`  ${st.yellow("!")} ${st.yellow(w)}\n`);

  process.stdout.write(
    `\n  ${st.gray("/help comandos  ·  @archivo adjunta  ·  \\ + Enter nueva línea  ·  Ctrl+C cancela  ·  /exit sale")}\n`,
  );
}

function printHelp(renderer: Renderer, customCount: number) {
  renderer.line();
  for (const l of rows(BUILTIN_COMMANDS.map(([c, d]) => [c, d]), st)) renderer.line(l);
  renderer.line();
  for (const l of rows(
    [
      ["@ruta/archivo", "Adjunta un archivo local como referencia"],
      ["\\ + Enter", "Nueva línea (también Option/Alt+Enter, Shift+Enter o Ctrl+J según la terminal)"],
      ["pegar", "Pega texto de varias líneas; si es largo se muestra resumido"],
      ["↑ / ↓", "Historial de mensajes (o moverse entre líneas)"],
      ["Tab", "Completa /comandos"],
      ["Ctrl+C", "Cancela el turno o borra el texto (dos veces para salir)"],
      ["Ctrl+D", "Sale si el campo está vacío"],
    ],
    st,
  )) {
    renderer.line(l);
  }
  renderer.line(
    st.gray(`\n  Otros /comandos se buscan en .agents/commands/${customCount ? ` (${customCount} disponibles, ver /commands)` : ""} o se envían al agente.`),
  );
}

function statusRows(ctx: Context, session: { id: string; modes: SessionModeState | null }): string[] {
  const { ready, init, host, renderer } = ctx;
  const entries: Array<[string, string]> = [
    ["host", `${host.name === "url" ? "RELAY_URL" : host.name} ${st.gray(host.url)}`],
    ["daemon", `${ready.daemon.hostname} ${st.gray(`v${ready.daemon.version}`)}`],
    ["agente", `${ready.provider} ${st.gray(`${shortAgentName(init.agentInfo?.name)} ${init.agentInfo?.version ?? ""}`)}`],
  ];
  const model = renderer.configValue("model");
  if (model) entries.push(["modelo", model]);
  const effort = renderer.configValue("effort");
  if (effort) entries.push(["esfuerzo", effort]);
  const mode = renderer.currentMode ?? session.modes?.currentModeId;
  if (mode) entries.push(["modo", mode]);
  entries.push(["puente", bridgeLabel(ready)]);
  entries.push(["espejo", st.gray(tildify(ready.remoteWorkspace))]);
  entries.push(["sesión", st.gray(session.id)]);
  return rows(entries, st);
}

function printDoctor(ctx: Context, warnings: string[]) {
  const { ready, init, host, root } = ctx;
  const ok = st.green("✓");
  const warn = st.yellow("!");
  const b = ready.toolBridge;
  const bridgeOk = b?.enabled && b.preset !== "none";
  const rg = ripgrepVersion();

  process.stdout.write(`\n  ${st.bold(st.accent("◆ agent-relay doctor"))}  ${st.gray(`v${packageVersion()}`)}\n\n`);
  const checks: Array<[string, string, string]> = [
    [ok, "conexión", `${host.url} ${st.gray("→")} ${ready.daemon.hostname}`],
    [ok, "daemon", `v${ready.daemon.version}`],
    [ok, "agente", `${shortAgentName(init.agentInfo?.name)} ${init.agentInfo?.version ?? ""} ${st.gray(`· ACP v${init.protocolVersion}`)}`],
    [
      bridgeOk ? ok : warn,
      "puente",
      !b ? "desconocido (daemon anterior a v0.4)" : !b.enabled ? "desactivado" : `activo (preset ${b.preset})`,
    ],
    [rg ? ok : warn, "ripgrep", rg ?? `no encontrado. ${RIPGREP_HINT}`],
    [ok, "proyecto", tildify(root)],
    [ok, "espejo", tildify(ready.remoteWorkspace)],
    [ok, "proveedores", ready.availableProviders.join(", ")],
  ];
  const width = Math.max(...checks.map(([, k]) => k.length));
  for (const [mark, k, v] of checks) process.stdout.write(`  ${mark} ${st.gray(k.padEnd(width))}  ${v}\n`);

  const localKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY"].filter((k) => process.env[k]);
  if (localKeys.length) warnings.push(`${localKeys.join(", ")} definidas aquí; relay no las usa, el consumo ocurre en el daemon.`);
  if (warnings.length) process.stdout.write("\n");
  for (const w of warnings) process.stdout.write(`  ${warn} ${st.yellow(w)}\n`);
  process.stdout.write("\n");
}

function renderModes(modes: SessionModeState | null, renderer: Renderer) {
  if (!modes?.availableModes?.length) {
    renderer.line(st.gray("  El agente no anunció modos."));
    return;
  }
  renderer.line();
  const current = renderer.currentMode ?? modes.currentModeId;
  for (const l of rows(
    modes.availableModes.map((m) => [m.id, `${m.name}${m.id === current ? `  ${st.green("← actual")}` : ""}`]),
    st,
  )) {
    renderer.line(l);
  }
  renderer.line(st.gray("\n  Cambia con /mode <id>"));
}

async function modelCommand(acp: ClientConnection, sessionId: string, args: string, renderer: Renderer) {
  const opt = renderer.configOptions.find((o) => o.id === "model" || ("category" in o && o.category === "model"));
  if (!opt || opt.type !== "select") {
    renderer.line(st.gray("  El agente no permite elegir modelo desde el cliente."));
    return;
  }
  const choices = flattenChoices(opt);
  if (!args) {
    renderer.line();
    for (const l of rows(
      choices.map((c) => [c.value, `${c.name}${c.value === opt.currentValue ? `  ${st.green("← actual")}` : ""}`]),
      st,
    )) {
      renderer.line(l);
    }
    renderer.line(st.gray("\n  Cambia con /model <id>"));
    return;
  }
  const choice = choices.find((c) => c.value === args || c.name.toLowerCase() === args.toLowerCase());
  if (!choice) {
    renderer.line(st.red(`  ✗ modelo desconocido: ${args}. Usa /model para ver las opciones.`));
    return;
  }
  try {
    const res = await acp.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: opt.id, value: choice.value });
    renderer.configOptions = res.configOptions;
    renderer.line(st.gray(`  modelo → ${choice.name}`));
  } catch (err) {
    renderer.line(st.red(`  ✗ no se pudo cambiar el modelo: ${(err as Error).message}`));
  }
}

function flattenChoices(opt: SessionConfigOption): Array<{ value: string; name: string }> {
  if (opt.type !== "select") return [];
  return (opt.options as Array<{ value?: string; name?: string; options?: Array<{ value: string; name: string }> }>)
    .flatMap((o) => o.options ?? [o])
    .filter((o): o is { value: string; name: string } => typeof o.value === "string");
}

// ─── Lógica ──────────────────────────────────────────────────────────────────

const RIPGREP_HINT =
  process.platform === "darwin"
    ? "Instálalo con: brew install ripgrep"
    : process.platform === "win32"
      ? "Instálalo con: winget install BurntSushi.ripgrep.MSVC"
      : "Instálalo con: sudo apt install ripgrep (o el gestor de tu distribución)";

let ripgrepCache: string | null | undefined;
/** Versión de ripgrep instalada en esta máquina (donde corren grep y glob del puente). */
function ripgrepVersion(): string | null {
  if (ripgrepCache !== undefined) return ripgrepCache;
  const r = spawnSync("rg", ["--version"], { encoding: "utf8" });
  ripgrepCache = r.status === 0 ? (r.stdout.split("\n")[0]?.trim() ?? "rg") : null;
  return ripgrepCache;
}

/** Avisos sobre la conexión: puente inactivo o sin ripgrep. */
function connectionWarnings(ctx: Context): string[] {
  const out: string[] = [];
  const b = ctx.ready.toolBridge;
  if (!b) {
    out.push(
      `el daemon (v${ctx.ready.daemon.version}) no informa el puente de herramientas; actualízalo (git pull && npm run build) y reinícialo, o el agente trabajará sobre la máquina remota.`,
    );
  } else if (!b.enabled) {
    out.push("el puente está desactivado: las herramientas del agente actúan sobre la máquina remota, no sobre este proyecto.");
  } else if (b.preset === "none") {
    out.push("el agente conserva sus herramientas internas (preset none) y puede usarlas sobre la máquina remota en lugar de este proyecto.");
  }
  if (b?.enabled && !ripgrepVersion()) out.push(`ripgrep no está instalado aquí; las búsquedas del agente serán más lentas. ${RIPGREP_HINT}`);
  return out;
}

async function newSession(acp: ClientConnection, root: string, renderer: Renderer) {
  try {
    const res = await acp.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    if (res.modes?.currentModeId) renderer.currentMode = res.modes.currentModeId;
    renderer.configOptions = res.configOptions ?? [];
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

async function runTurn(acp: ClientConnection, sessionId: string, prompt: ContentBlock[], renderer: Renderer, decorate: boolean) {
  if (decorate) renderer.beginTurn();
  try {
    const res = await acp.agent.request(methods.agent.session.prompt, { sessionId, prompt });
    if (decorate) renderer.endTurn(res.stopReason);
    else {
      renderer.newline();
      if (res.stopReason !== "end_turn") renderer.line(st.gray(`(fin del turno: ${res.stopReason})`));
    }
    return res.stopReason;
  } catch (err) {
    renderer.line(st.red(`  ✗ ${(err as Error).message}`));
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

const PERMISSION_LABEL: Record<string, string> = {
  allow_once: "Sí, esta vez",
  allow_always: "Sí, no volver a preguntar",
  reject_once: "No",
  reject_always: "No, nunca",
};

/** Lo más útil para decidir: el comando, la ruta o el patrón que pide el agente. */
function permissionDetail(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.command === "string") return `${st.gray("$")} ${r.command}`;
  const p = r.path ?? r.file_path;
  if (typeof p === "string") return tildify(p);
  if (typeof r.pattern === "string") return r.pattern;
  return undefined;
}

async function requestPermission(
  req: RequestPermissionRequest,
  ctx: { autoApprove: boolean; interactive: boolean; ask: (q: string) => Promise<string>; renderer: Renderer },
): Promise<RequestPermissionResponse> {
  const { renderer } = ctx;
  const rawTitle = req.toolCall.title ?? req.toolCall.toolCallId;
  const name = rawTitle.replace(/^(?:mcp__relay__|relay_)/, "");
  const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind === "allow_always");
  const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind === "reject_always");
  const denied = (): RequestPermissionResponse =>
    reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };

  if (ctx.autoApprove && allow) {
    renderer.line(st.gray(`  ✓ permiso automático: ${name}`));
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  if (!ctx.interactive) {
    renderer.line(st.yellow(`  ! permiso denegado (modo no interactivo, usa --yes): ${name}`));
    return denied();
  }

  const detail = permissionDetail(req.toolCall.rawInput);
  renderer.line();
  renderer.line(`  ${st.yellow("?")} ${st.bold(name)} ${st.gray("pide permiso para ejecutarse en tu máquina")}`);
  if (detail) renderer.line(`    ${truncate(detail, (process.stdout.columns || 80) - 6)}`);
  renderer.line(
    `    ${req.options.map((o, i) => `${st.accent(`[${i + 1}]`)} ${PERMISSION_LABEL[o.kind] ?? o.name}`).join("   ")}`,
  );
  for (;;) {
    let answer: string;
    try {
      answer = (await ctx.ask(`    ${st.accent("›")} `)).trim().toLowerCase();
    } catch {
      return denied(); // Ctrl+C / Ctrl+D en la pregunta
    }
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && req.options[idx]) return { outcome: { outcome: "selected", optionId: req.options[idx].optionId } };
    if (answer === "s" || answer === "si" || answer === "sí" || answer === "y") {
      if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    if (answer === "" || answer === "n" || answer === "no") return denied();
  }
}

main().catch((err) => {
  process.stderr.write(`${st.red("✗ relay:")} ${(err as Error).message}\n`);
  process.exit(1);
});
