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
import { packageVersion } from "../shared/version.js";
import { generateToken, isAuthorized } from "./auth.js";
import { defaultDaemonConfigPath, loadDaemonConfig, type DaemonConfig } from "./config.js";
import { bridgeSession } from "./session.js";
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

function log(msg: string) {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

function usage(): never {
  process.stdout.write(`relay-daemon ${packageVersion()}

Uso:
  relay-daemon [--config <ruta>]     Inicia el daemon (por defecto ${defaultDaemonConfigPath()})
  relay-daemon check [--config <ruta>]  Valida la configuración
  relay-daemon gen-token             Genera un token y su hash SHA-256
`);
  process.exit(0);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string", short: "c" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) usage();

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
        `Proveedores: ${Object.keys(config.providers).join(", ")} (por defecto: ${config.defaultProvider})\n` +
        `Escucha en ${config.tls ? "wss" : "ws"}://${config.listen.host}:${config.listen.port}` +
        `${config.tls?.clientCa ? " con mTLS" : ""}\n`,
    );
    return;
  }
  if (command !== "serve") usage();

  serve(config);
}

function serve(config: DaemonConfig) {
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
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, peer ?? "?", config));
  });

  server.listen(config.listen.port, config.listen.host, () => {
    log(
      `relay-daemon ${packageVersion()} escuchando en ${config.tls ? "wss" : "ws"}://${config.listen.host}:${config.listen.port}/acp` +
        (config.tls?.clientCa ? " (mTLS)" : config.tls ? " (TLS)" : " (sin TLS: úsalo solo dentro de Tailscale/WireGuard o la LAN)"),
    );
    log(`proveedores: ${Object.keys(config.providers).join(", ")} · por defecto: ${config.defaultProvider}`);
  });

  const stop = () => {
    log("apagando…");
    for (const client of wss.clients) client.close(1001, "daemon-shutdown");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function onConnection(ws: WebSocket, peer: string, config: DaemonConfig) {
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
    log(`${tag} sesión abierta desde ${peer} · ${hello.project.files.length} archivo(s) abiertos sincronizados`);

    sendControl({
      type: "relay/ready",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      provider: providerName,
      availableProviders: Object.keys(config.providers),
      remoteWorkspace: remoteRoot,
      daemon: { version: packageVersion(), hostname: hostname() },
    });

    bridgeSession({
      ws,
      providerName,
      provider,
      remoteRoot,
      localRoot: hello.project.localRoot,
      localSep: hello.project.pathSeparator,
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
