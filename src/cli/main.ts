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
  type SessionInfo,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { ProjectFile, ReadyFrame } from "../shared/protocol.js";
import { box, rows, stripAnsi, termWidth, tildify, truncate, truncateStart, visibleWidth } from "../shared/ui.js";
import { packageVersion } from "../shared/version.js";
import { INIT_PROMPT, expandTemplate, loadCustomCommands } from "./commands.js";
import { configDir, defaultCliConfigPath, loadCliConfig, resolveHost, type ResolvedHost } from "./config.js";
import { InputEditor } from "./input.js";
import { LocalTools } from "./local-tools.js";
import { collectProjectFiles, findProjectRoot, projectId } from "./project.js";
import { Renderer, st } from "./render.js";
import {
  canList,
  canRestore,
  lastRememberedSession,
  listSessions,
  pickSession,
  rememberSession,
  restoreSession,
  sessionRows,
  transcriptLines,
  type ActiveSession,
  type ReplayTurn,
} from "./sessions.js";
import { connectRelay, type RelayConnection } from "./transport.js";

const HELP = `${st.bold(st.accent("◆ agent-relay"))} ${st.gray(`v${packageVersion()}`)}
Agentes de código que corren en otra máquina y trabajan sobre tu proyecto local.

${st.bold("Uso")}
  relay [opciones]                 Sesión interactiva
  relay [opciones] -p "<prompt>"   Un solo prompt y salir
  relay -C                         Continúa la última sesión de este proyecto
  relay --resume [id]              Elige una sesión anterior (o reanuda la indicada)
  relay sessions                   Lista las sesiones de este proyecto
  relay doctor [opciones]          Verifica conexión, agente, puente y ripgrep

${st.bold("Opciones")}
  -H, --host <nombre>     Host definido en ${tildify(defaultCliConfigPath())}
  -a, --agent <nombre>    Proveedor en el daemon (claude, codex, opencode…)
      --url <ws(s)://…>   Conexión directa (requiere RELAY_TOKEN)
  -p, --print <prompt>    Modo no interactivo (combinable con -C o --resume <id>)
  -C, --continue          Continúa la última sesión de este proyecto
  -r, --resume [id]       Reanuda una sesión; sin id muestra la lista
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
  ["/resume [n|id]", "Lista las sesiones de este proyecto y reanuda una"],
  ["/init", "Crea o mejora AGENTS.md (formato abierto)"],
  ["/model [id]", "Muestra o cambia el modelo"],
  ["/mode [id]", "Muestra o cambia el modo del agente"],
  ["/commands", "Comandos personalizados y del agente"],
  ["/status", "Conexión, agente, puente y sesión"],
  ["/reconnect", "Reconecta con el daemon si se perdió la conexión"],
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

/**
 * `--resume` acepta un id opcional ("relay --resume" lista, "relay --resume abc"
 * reanuda), algo que parseArgs no admite: se extrae antes.
 */
function extractResume(argv: string[]): { argv: string[]; resume?: string | true } {
  const out: string[] = [];
  let resume: string | true | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resume" || a === "-r") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        resume = next;
        i++;
      } else resume = true;
    } else if (a.startsWith("--resume=")) resume = a.slice("--resume=".length) || true;
    else out.push(a);
  }
  return { argv: out, resume };
}

const RECONNECT_ATTEMPTS = 12;

async function main() {
  const pre = extractResume(process.argv.slice(2));
  const { values, positionals } = parseArgs({
    args: pre.argv,
    allowPositionals: true,
    options: {
      host: { type: "string", short: "H" },
      agent: { type: "string", short: "a" },
      url: { type: "string" },
      print: { type: "string", short: "p" },
      continue: { type: "boolean", short: "C" },
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
  const isSessions = subcommand === "sessions";
  const interactive = values.print === undefined && !isDoctor && !isSessions;
  const cfg = loadCliConfig(values.config ?? defaultCliConfigPath());
  const host = resolveHost(cfg, values.host, values.url);
  const autoApprove = values.yes ?? cfg.permissions.autoApprove;

  const root = findProjectRoot(values.cwd ?? process.cwd());
  const pid = projectId(root);
  const { files, warnings: projectWarnings } = collectProjectFiles(root);

  const renderer = new Renderer(values.thoughts ?? false);
  const tools = new LocalTools(root, cfg.permissions.extraRoots, (k, d) => renderer.local(k, d));

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
  /** Avisos que pueden llegar mientras el usuario escribe (reconexión). */
  const notify = (text: string) => (editor?.reading ? editor.printAbove(text) : renderer.line(text));

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

  // ── Conexión con el daemon (se puede reabrir) ─────────────────────────────
  interface Live {
    relay: RelayConnection;
    acp: ClientConnection;
    init: InitializeResponse;
    open: boolean;
  }
  let closing = false;
  let reconnecting: Promise<boolean> | null = null;
  let session: ActiveSession | undefined;

  const openLive = async (): Promise<Live> => {
    const relay = await connectRelay({ host, provider: values.agent, project: { root, id: pid, files } });
    const acp = app.connect(relay.stream);
    const live: Live = { relay, acp, init: undefined as unknown as InitializeResponse, open: true };
    relay.closed.then(({ code, reason }) => onClosed(live, code, reason));
    live.init = await acp.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "agent-relay", title: "agent-relay CLI", version: packageVersion() },
    });
    return live;
  };

  const onClosed = (l: Live, code: number, reason: string) => {
    l.open = false;
    tools.disposeAll();
    l.acp.close();
    if (closing || l !== live) return;
    const why = `${code}${reason ? ` ${reason}` : ""}`;
    if (!interactive) {
      renderer.line(st.yellow(`  ! conexión con el daemon cerrada (${why})`));
      return;
    }
    notify(st.yellow(`  ! se perdió la conexión con el daemon (${why})`));
    void reconnect();
  };

  /** Reintenta con espera creciente y restaura la sesión actual sin reproducirla. */
  const reconnect = (): Promise<boolean> =>
    (reconnecting ??= (async () => {
      for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS && !closing; attempt++) {
        try {
          const next = await openLive();
          live = next;
          ctx.ready = next.relay.ready;
          ctx.init = next.init;
          if (session) {
            const restored = await restoreSession(next.acp, next.init, root, session.id, false);
            session = { ...session, ...restored };
            renderer.configOptions = restored.configOptions;
          }
          notify(st.green(`  ✓ reconectado${session ? " · sesión restaurada" : ""}`));
          return true;
        } catch (err) {
          const delay = Math.min(15_000, 1000 * 2 ** (attempt - 1));
          if (attempt === RECONNECT_ATTEMPTS) break;
          const why = (err as Error).message.replace(/^No se pudo conectar a \S+:\s*/, "");
          notify(st.gray(`  reconectando en ${Math.round(delay / 1000)} s · intento ${attempt + 1}/${RECONNECT_ATTEMPTS} · ${truncate(why, 50)}`));
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (!closing) notify(st.red("  ✗ no se pudo reconectar con el daemon. Escribe /reconnect para intentarlo de nuevo."));
      return false;
    })().finally(() => {
      reconnecting = null;
    }));

  /** La conexión actual, esperando a una reconexión en curso. */
  const getLive = async (): Promise<Live> => {
    if (reconnecting) await reconnecting;
    if (!live.open) throw new Error("sin conexión con el daemon; escribe /reconnect");
    return live;
  };

  const shutdown = () => {
    closing = true;
    editor?.stop();
    fallback?.close();
    live.relay.close();
  };

  if (interactive) process.stdout.write(st.gray(`  conectando con ${host.url}…\r`));
  let live = await openLive();
  if (interactive) process.stdout.write("\x1b[2K");

  const ctx: Context = { host, ready: live.relay.ready, init: live.init, root, files, renderer };
  const warnings = [...projectWarnings, ...connectionWarnings(ctx)];

  if (isDoctor) {
    printDoctor(ctx, warnings);
    shutdown();
    return;
  }

  if (isSessions) {
    printSessionList(await listSessions(live.acp, live.init, root), ctx);
    shutdown();
    return;
  }

  // ── Sesión inicial: nueva, la última (-C) o una elegida (--resume) ───────
  const startNew = async () => {
    const created = await newSession(live.acp, root, renderer);
    rememberSession(pid, live.relay.ready.provider, created.id);
    return created;
  };

  /** Restaura una sesión y devuelve el resumen de su conversación. */
  const resumeById = async (id: string, info?: SessionInfo): Promise<string[]> => {
    renderer.sessionTitle = undefined;
    renderer.beginReplay();
    let turns: ReplayTurn[] = [];
    try {
      const restored = await restoreSession(live.acp, live.init, root, id, true);
      session = { ...restored, title: info?.title };
      renderer.configOptions = restored.configOptions;
      if (restored.modes?.currentModeId) renderer.currentMode = restored.modes.currentModeId;
    } finally {
      turns = renderer.endReplay();
    }
    rememberSession(pid, live.relay.ready.provider, id);
    const title = info?.title ? ` · ${st.bold(truncate(info.title, 60))}` : "";
    return [`  ${st.accent("↺")} sesión reanudada${title} ${st.gray(`· ${id.slice(0, 8)}`)}`, ...transcriptLines(turns, st, termWidth())];
  };

  /** Lista las sesiones y deja elegir una. Devuelve undefined si se cancela. */
  const chooseSession = async (): Promise<SessionInfo | undefined> => {
    const sessions = await listSessions(live.acp, live.init, root);
    if (!sessions.length) {
      renderer.line(st.gray("  No hay sesiones anteriores de este proyecto con este agente."));
      return undefined;
    }
    const shown = sessions.slice(0, 20);
    renderer.line();
    for (const l of sessionRows(shown, st, termWidth(), session?.id)) renderer.line(l);
    if (sessions.length > shown.length) renderer.line(st.gray(`  … y ${sessions.length - shown.length} más (relay sessions las muestra todas)`));
    let answer: string;
    try {
      answer = await ask(`\n  ${st.accent("›")} número o id de la sesión ${st.gray("(Enter cancela)")}: `);
    } catch {
      return undefined;
    }
    if (!answer.trim()) return undefined;
    const picked = pickSession(sessions, answer);
    if (!picked) renderer.line(st.red(`  ✗ no encontré la sesión "${answer.trim()}"`));
    return picked;
  };

  let resumeSummary: string[] = [];
  const wantsResume = pre.resume !== undefined || values.continue;
  if (wantsResume && !canRestore(live.init)) {
    warnings.push(`${live.relay.ready.provider} no permite reanudar sesiones; se abre una nueva.`);
  } else if (typeof pre.resume === "string") {
    const sessions = canList(live.init) ? await listSessions(live.acp, live.init, root) : [];
    const info = pickSession(sessions, pre.resume);
    resumeSummary = await resumeById(info?.sessionId ?? pre.resume, info);
  } else if (pre.resume === true) {
    if (!interactive) throw new Error("--resume sin id solo funciona en modo interactivo; usa relay sessions para ver los ids");
    const picked = await chooseSession();
    if (picked) resumeSummary = await resumeById(picked.sessionId, picked);
  } else if (values.continue) {
    const sessions = canList(live.init) ? await listSessions(live.acp, live.init, root) : [];
    const lastId = sessions[0]?.sessionId ?? lastRememberedSession(pid, live.relay.ready.provider);
    if (lastId) resumeSummary = await resumeById(lastId, sessions.find((x) => x.sessionId === lastId));
    else warnings.push("no hay sesiones anteriores de este proyecto; se abre una nueva.");
  }
  if (!session) session = await startNew();

  if (!interactive) {
    // En modo -p la salida estándar queda para la respuesta; el encabezado va a stderr.
    process.stderr.write(st.gray(`agent-relay v${packageVersion()} · ${live.relay.ready.provider} en ${live.relay.ready.daemon.hostname}\n`));
    if (resumeSummary.length) process.stderr.write(st.gray(`${stripAnsi(resumeSummary[0]).trim()}\n`));
    for (const w of warnings) process.stderr.write(st.yellow(`! ${w}\n`));
    const stop = await runTurn(live.acp, session!.id, buildPrompt(values.print ?? "", process.cwd()), renderer, false);
    renderer.newline();
    shutdown();
    process.exitCode = stop === "error" ? 1 : 0;
    return;
  }

  printBanner(ctx, session!, warnings);
  if (resumeSummary.length) {
    renderer.line();
    for (const l of resumeSummary) renderer.line(l);
  }

  let turnActive = false;
  let lastSigint = 0;
  const onInterrupt = () => {
    if (turnActive && session) {
      renderer.line(st.yellow("  cancelando…"));
      if (live.open) void live.acp.agent.notify(methods.agent.session.cancel, { sessionId: session.id });
      return;
    }
    if (Date.now() - lastSigint < 1500) {
      shutdown();
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
      try {
        switch (cmd) {
          case "exit":
          case "quit":
            shutdown();
            return;
          case "help":
            printHelp(renderer, commands().size);
            continue;
          case "clear":
            process.stdout.write("\x1b[2J\x1b[H");
            continue;
          case "new": {
            const l = await getLive();
            session = await newSession(l.acp, root, renderer);
            renderer.sessionTitle = undefined;
            rememberSession(pid, l.relay.ready.provider, session.id);
            renderer.line(st.gray(`  nueva sesión ${session.id.slice(0, 8)}`));
            continue;
          }
          case "resume":
          case "sessions": {
            const l = await getLive();
            if (!canRestore(l.init)) {
              renderer.line(st.gray(`  ${l.relay.ready.provider} no permite reanudar sesiones.`));
              continue;
            }
            let target: SessionInfo | undefined;
            if (args) {
              const sessions = await listSessions(l.acp, l.init, root);
              target = pickSession(sessions, args) ?? { sessionId: args, cwd: root };
            } else target = await chooseSession();
            if (!target) continue;
            if (target.sessionId === session?.id) {
              renderer.line(st.gray("  Ya estás en esa sesión."));
              continue;
            }
            renderer.line();
            for (const line of await resumeById(target.sessionId, target)) renderer.line(line);
            continue;
          }
          case "reconnect":
            if (live.open && !reconnecting) renderer.line(st.gray("  La conexión con el daemon está activa."));
            else await reconnect();
            continue;
          case "status":
            renderer.line();
            for (const l of statusRows(ctx, session!, live.open)) renderer.line(l);
            continue;
          case "modes":
          case "mode": {
            if (!args) {
              renderModes(session!.modes, renderer);
              continue;
            }
            const l = await getLive();
            await l.acp.agent.request(methods.agent.session.setMode, { sessionId: session!.id, modeId: args });
            renderer.currentMode = args;
            renderer.line(st.gray(`  modo → ${args}`));
            continue;
          }
          case "model":
          case "models":
            await modelCommand((await getLive()).acp, session!.id, args, renderer);
            continue;
          case "commands": {
            const custom = [...commands().values()];
            renderer.line();
            renderer.line(`  ${st.bold("Personalizados")} ${st.gray(".agents/commands")}`);
            if (!custom.length) renderer.line(st.gray("    (ninguno)"));
            for (const l of rows(custom.map((c) => [`/${c.name}`, `${c.description} ${st.gray(`[${c.source}]`)}`]), st, "    ")) renderer.line(l);
            renderer.line(`  ${st.bold("Del agente")} ${st.gray(ctx.ready.provider)}`);
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
      } catch (err) {
        renderer.line(st.red(`  ✗ ${(err as Error).message}`));
        continue;
      }
    }

    turnActive = true;
    try {
      const l = await getLive();
      await runTurn(l.acp, session!.id, buildPrompt(promptText, process.cwd()), renderer, true);
    } catch (err) {
      renderer.line(st.red(`  ✗ ${(err as Error).message}`));
    } finally {
      turnActive = false;
    }
  }

  shutdown();
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

function statusRows(ctx: Context, session: ActiveSession, connected: boolean): string[] {
  const { ready, init, host, renderer } = ctx;
  const entries: Array<[string, string]> = [
    ["host", `${host.name === "url" ? "RELAY_URL" : host.name} ${st.gray(host.url)}`],
    ["daemon", `${ready.daemon.hostname} ${st.gray(`v${ready.daemon.version}`)}${connected ? "" : `  ${st.red("desconectado")}`}`],
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
  const title = renderer.sessionTitle ?? session.title;
  entries.push(["sesión", `${title ? `${truncate(title, 50)} ` : ""}${st.gray(session.id)}`]);
  return rows(entries, st);
}

function printSessionList(sessions: SessionInfo[], ctx: Context) {
  const { ready, root } = ctx;
  process.stdout.write(`\n  ${st.bold(st.accent("◆ sesiones"))}  ${st.gray(`${ready.provider} · ${tildify(root)}`)}\n\n`);
  if (!sessions.length) {
    process.stdout.write(st.gray("  No hay sesiones anteriores de este proyecto con este agente.\n\n"));
    return;
  }
  for (const l of sessionRows(sessions, st, termWidth())) process.stdout.write(`${l}\n`);
  process.stdout.write(st.gray(`\n  Reanuda con: relay --resume <número o id>   ·   la última: relay -C\n\n`));
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

async function newSession(acp: ClientConnection, root: string, renderer: Renderer): Promise<ActiveSession> {
  try {
    const res = await acp.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    if (res.modes?.currentModeId) renderer.currentMode = res.modes.currentModeId;
    renderer.configOptions = res.configOptions ?? [];
    return { id: res.sessionId, modes: res.modes ?? null, configOptions: res.configOptions ?? [] };
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
    const msg = (err as Error).message;
    renderer.line(
      /connection closed|conexión con el daemon cerrada/i.test(msg)
        ? st.yellow("  ✗ el turno se interrumpió porque se perdió la conexión; cuando se reconecte puedes repetirlo")
        : st.red(`  ✗ ${msg}`),
    );
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
