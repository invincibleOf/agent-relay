#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  RELAY_PROTOCOL_VERSION,
  type ErrorFrame,
  type HelloFrame,
  type ReadyFrame,
} from "../shared/protocol.js";
import { box, isTTY, makeStyles, rows, stripAnsi, tildify } from "../shared/ui.js";
import { packageVersion } from "../shared/version.js";
import { generateToken, isAuthorized } from "./auth.js";
import { defaultDaemonConfigPath, loadDaemonConfig, type DaemonConfig } from "./config.js";
import { bridgeSession } from "./session.js";
import { ToolBridgeHub } from "./tool-bridge.js";
import { materializeWorkspace } from "./workspace.js";

const HELLO_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

const HelloSchema = z.object({
  type: z.literal("relay/hello"),
  protocolVersion: z.number(),
  provider: z.string().optional(),
  project: z.object({
    localRoot: z.string().min(1),
    id: z.string().regex(/^[0-9a-f]{8,64}$/),
    name: z.string(),
    pathSeparator: z.enum(["/", "\\"]),
    files: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
  }),
  client: z.object({ name: z.string(), version: z.string(), hostname: z.string() }),
});

const st = makeStyles(isTTY(process.stderr));

/** Línea de log: hora local, etiqueta de sesión resaltada y avisos en amarillo. */
function log(msg: string) {
  const time = new Date().toTimeString().slice(0, 8);
  let text = msg.replace(/^(\[[^\]]+\])/, (t) => st.accent(t));
  if (/^(\S+ )?(aviso|no se pudo|error)/i.test(stripAnsi(text).replace(/^\[[^\]]+\] /, ""))) text = st.yellow(text);
  text = text.replace(/(puente → |→ delegado al cliente por ACP: )/, (t) => st.blue(t));
  process.stderr.write(`${st.gray(time)}  ${text}\n`);
}

function printDaemonBanner(config: DaemonConfig) {
  const scheme = config.tls ? "wss" : "ws";
  const url = `${scheme}://${config.listen.host}:${config.listen.port}/acp`;
  const security = config.tls?.clientCa
    ? st.green("TLS 1.3 + mTLS")
    : config.tls
      ? st.green("TLS 1.3")
      : st.yellow("sin TLS · úsalo solo dentro de Tailscale/WireGuard o la LAN");
  const nameWidth = Math.max(...Object.keys(config.providers).map((n) => n.length + (n === config.defaultProvider ? 14 : 0)));
  const providerLines = Object.entries(config.providers).map(([name, p]) => {
    const isDefault = name === config.defaultProvider ? st.gray(" (por defecto)") : "";
    const pad = " ".repeat(Math.max(0, nameWidth - name.length - (isDefault ? 14 : 0)));
    const bridge = !p.toolBridge.enabled
      ? st.yellow("puente desactivado")
      : p.toolBridge.preset === "none"
        ? st.yellow("puente sin preset")
        : `${st.green("✓")} ${st.gray(`puente · preset ${p.toolBridge.preset}`)}`;
    return `${st.bold(name)}${isDefault}${pad}  ${bridge}`;
  });
  const entries: Array<[string, string]> = [
    ["escucha", `${st.bold(url)}`],
    ["seguridad", security],
    ["proveedores", providerLines[0] ?? ""],
    ...providerLines.slice(1).map((l): [string, string] => ["", l]),
    ["espejos", st.gray(tildify(config.workspacesDir))],
    ["tokens", `${config.auth.tokenSha256.length} autorizado${config.auth.tokenSha256.length === 1 ? "" : "s"}`],
  ];
  const out = [
    "",
    box([`${st.bold(st.accent("◆ relay-daemon"))}  ${st.gray(`v${packageVersion()}`)}`, st.gray(`agent-relay en ${hostname()} · node ${process.versions.node} · pid ${process.pid}`)], st),
    "",
    ...rows(entries, st),
    "",
  ];
  process.stderr.write(out.join("\n") + "\n");
}

function usage(): never {
  const out = makeStyles(isTTY());
  process.stdout.write(`${out.bold(out.accent("◆ relay-daemon"))} ${out.gray(`v${packageVersion()}`)}
Daemon de agent-relay: ejecuta los agentes y es el único que consume los proveedores de IA.

${out.bold("Uso")}
  relay-daemon [--config <ruta>]         Inicia el daemon (por defecto ${tildify(defaultDaemonConfigPath())})
  relay-daemon check [--config <ruta>]   Valida la configuración y muestra el preset de cada proveedor
  relay-daemon gen-token                 Genera un token y su hash SHA-256
  relay-daemon --version

${out.bold("Variables")}
  RELAY_DEBUG=1       Muestra toda la salida de los adaptadores
  RELAY_DEBUG_MCP=1   Registra cada llamada del agente al puente de herramientas
`);
  process.exit(0);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) usage();
  if (values.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  const command = positionals[0] ?? "serve";
  if (command === "gen-token") {
    const { token, sha256 } = generateToken();
    process.stdout.write(
      `Token (guárdalo en la config del CLI, no se vuelve a mostrar):\n  ${token}\n\n` +
        `Hash para daemon.yaml → auth.tokenSha256:\n  - "${sha256}"\n`,
    );
    return;
  }

  const configPath = values.config ?? defaultDaemonConfigPath();
  const config = loadDaemonConfig(configPath);

  if (command === "check") {
    process.stdout.write(
      `Configuración válida: ${configPath}\n` +
        `Proveedores (por defecto: ${config.defaultProvider}):\n` +
        Object.entries(config.providers)
          .map(([n, p]) => `  - ${n}: puente ${p.toolBridge.enabled ? `activo, preset ${p.toolBridge.preset}` : "desactivado"}\n`)
          .join("") +
        `Escucha en ${config.tls ? "wss" : "ws"}://${config.listen.host}:${config.listen.port}` +
        `${config.tls?.clientCa ? " con mTLS" : ""}\n`,
    );
    return;
  }
  if (command !== "serve") usage();

  void serve(config);
}

async function serve(config: DaemonConfig) {
  const hub = new ToolBridgeHub();
  await hub.start();

  const onHttp = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  };

  const server = config.tls
    ? createHttpsServer(
        {
          cert: readFileSync(config.tls.cert),
          key: readFileSync(config.tls.key),
          ...(config.tls.clientCa
            ? { ca: readFileSync(config.tls.clientCa), requestCert: true, rejectUnauthorized: true }
            : {}),
          minVersion: "TLSv1.3",
        },
        onHttp,
      )
    : createHttpServer(onHttp);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (req, socket, head) => {
    const peer = req.socket.remoteAddress;
    if (new URL(req.url ?? "/", "http://x").pathname !== "/acp") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (!isAuthorized(req, config.auth.tokenSha256)) {
      log(`conexión rechazada desde ${peer}: token inválido`);
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, peer ?? "?", config, hub));
  });

  server.listen(config.listen.port, config.listen.host, () => {
    printDaemonBanner(config);
    log(`escuchando conexiones · Ctrl+C para detener`);
    for (const [n, p] of Object.entries(config.providers)) {
      if (!p.toolBridge.enabled) log(`aviso: ${n} tiene el puente desactivado; sus herramientas actuarán sobre esta máquina`);
      else if (p.toolBridge.preset === "none") log(`aviso: ${n} conserva sus herramientas internas (preset none); puede trabajar sobre esta máquina en vez de la del CLI`);
    }
  });

  const stop = () => {
    log("apagando…");
    for (const client of wss.clients) client.close(1001, "daemon-shutdown");
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function onConnection(ws: WebSocket, peer: string, config: DaemonConfig, hub: ToolBridgeHub) {
  const sendControl = (frame: ReadyFrame | ErrorFrame) => ws.send(JSON.stringify(frame));
  const fail = (message: string) => {
    log(`sesión rechazada (${peer}): ${message}`);
    sendControl({ type: "relay/error", message });
    ws.close(1008, "relay-error");
  };

  const timer = setTimeout(() => fail("no se recibió relay/hello a tiempo"), HELLO_TIMEOUT_MS);

  ws.once("message", (data) => {
    clearTimeout(timer);
    let hello: HelloFrame;
    try {
      hello = HelloSchema.parse(JSON.parse(data.toString())) as HelloFrame;
    } catch (err) {
      fail(`relay/hello inválido: ${(err as Error).message}`);
      return;
    }
    if (hello.protocolVersion !== RELAY_PROTOCOL_VERSION) {
      fail(`versión de protocolo incompatible (cliente ${hello.protocolVersion}, daemon ${RELAY_PROTOCOL_VERSION})`);
      return;
    }

    const providerName = hello.provider ?? config.defaultProvider;
    const provider = config.providers[providerName];
    if (!provider) {
      fail(`proveedor "${providerName}" no configurado. Disponibles: ${Object.keys(config.providers).join(", ")}`);
      return;
    }

    let remoteRoot: string;
    try {
      remoteRoot = materializeWorkspace(config.workspacesDir, hello.project.id, providerName, provider, hello.project.files);
    } catch (err) {
      fail(`no se pudo preparar el workspace: ${(err as Error).message}`);
      return;
    }

    const tag = `[${hello.client.hostname}:${hello.project.name}/${providerName}]`;
    log(`${tag} sesión abierta desde ${peer} · ${hello.project.files.length} archivo(s) en formato abierto · ${tildify(hello.project.localRoot)}`);

    sendControl({
      type: "relay/ready",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      provider: providerName,
      availableProviders: Object.keys(config.providers),
      remoteWorkspace: remoteRoot,
      daemon: { version: packageVersion(), hostname: hostname() },
      toolBridge: { enabled: provider.toolBridge.enabled, preset: provider.toolBridge.preset },
    });

    bridgeSession({
      ws,
      providerName,
      provider,
      remoteRoot,
      localRoot: hello.project.localRoot,
      localSep: hello.project.pathSeparator,
      hub,
      log: (m) => log(`${tag} ${m}`),
    });
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`relay-daemon: ${(err as Error).message}\n`);
  process.exit(1);
}
