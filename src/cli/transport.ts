import { hostname } from "node:os";
import path from "node:path";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import WebSocket from "ws";
import {
  RELAY_PROTOCOL_VERSION,
  isControlFrame,
  type HelloFrame,
  type ProjectFile,
  type ReadyFrame,
} from "../shared/protocol.js";
import { packageVersion } from "../shared/version.js";
import type { ResolvedHost } from "./config.js";

export interface RelayConnection {
  ready: ReadyFrame;
  stream: Stream;
  close(): void;
  closed: Promise<{ code: number; reason: string }>;
}

export interface ConnectOptions {
  host: ResolvedHost;
  provider?: string;
  project: { root: string; id: string; files: ProjectFile[] };
}

/**
 * Abre la conexión con el daemon, hace el handshake de control y devuelve un
 * Stream ACP listo para el SDK. El CLI nunca habla con un proveedor de IA:
 * este WebSocket hacia tu daemon es su única salida de red.
 */
export function connectRelay(opts: ConnectOptions): Promise<RelayConnection> {
  const { host, project } = opts;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(host.url, {
      headers: { authorization: `Bearer ${host.token}` },
      ca: host.ca,
      cert: host.cert,
      key: host.key,
      maxPayload: 32 * 1024 * 1024,
      handshakeTimeout: 10_000,
    });

    let settled = false;
    let readableController!: ReadableStreamDefaultController<AnyMessage>;

    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on("close", (code, reason) => {
        try {
          readableController?.close();
        } catch {
          /* ya cerrado */
        }
        res({ code, reason: reason.toString() });
        if (!settled) {
          settled = true;
          reject(new Error(`El daemon cerró la conexión (${code} ${reason.toString()})`));
        }
      });
    });

    ws.on("unexpected-response", (_req, res) => {
      settled = true;
      reject(new Error(res.statusCode === 401 ? "Token rechazado por el daemon (401)" : `Respuesta inesperada del daemon: HTTP ${res.statusCode}`));
      ws.terminate();
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`No se pudo conectar a ${host.url}: ${err.message}`));
      }
    });

    ws.on("open", () => {
      const hello: HelloFrame = {
        type: "relay/hello",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        provider: opts.provider ?? host.provider,
        project: {
          localRoot: project.root,
          id: project.id,
          name: path.basename(project.root),
          pathSeparator: path.sep,
          files: project.files,
        },
        client: { name: "agent-relay", version: packageVersion(), hostname: hostname() },
      };
      ws.send(JSON.stringify(hello));
    });

    const readable = new ReadableStream<AnyMessage>({
      start(controller) {
        readableController = controller;
      },
    });

    const writable = new WritableStream<AnyMessage>({
      write(msg) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error("Conexión con el daemon cerrada");
        ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close(1000);
      },
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!settled) {
        if (isControlFrame(msg) && msg.type === "relay/ready") {
          settled = true;
          resolve({ ready: msg, stream: { readable, writable }, close: () => ws.close(1000), closed });
        } else if (isControlFrame(msg) && msg.type === "relay/error") {
          settled = true;
          reject(new Error(`El daemon rechazó la sesión: ${msg.message}`));
          ws.close();
        }
        return;
      }

      try {
        readableController.enqueue(msg as AnyMessage);
      } catch {
        /* stream cerrado */
      }
    });
  });
}
