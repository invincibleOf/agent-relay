import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { rewritePathPrefix } from "../shared/protocol.js";
import { packageVersion } from "../shared/version.js";
import { BRIDGE_INSTRUCTIONS, BRIDGE_SERVER_NAME } from "./presets.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 100_000;
const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 600_000;

/** Envía peticiones ACP al CLI (fs/*, terminal/*) por la conexión existente. */
export interface ClientRequester {
  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface BridgeTarget {
  requester: ClientRequester;
  /** sessionId ACP; se resuelve cuando el agente responde a session/new. */
  sessionId: Promise<string>;
  remoteRoot: string;
  localRoot: string;
  localSep: string;
  log: (msg: string) => void;
}

/**
 * Servidor MCP local del daemon. Cada sesión ACP recibe una URL secreta
 * (http://127.0.0.1:<puerto>/mcp/<clave>) que se le pasa al agente en
 * session/new. Cuando el agente usa una herramienta del puente, el daemon NO la
 * ejecuta: la convierte en una petición ACP hacia el CLI, que la ejecuta en la
 * máquina local.
 *
 *   agente ──MCP tools/call──► daemon ──ACP fs/* · terminal/*──► CLI (tu disco)
 */
export class ToolBridgeHub {
  private server?: Server;
  private port = 0;
  private targets = new Map<string, BridgeTarget>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  register(target: BridgeTarget): { key: string; url: string } {
    if (!this.server) throw new Error("ToolBridgeHub no iniciado");
    const key = randomBytes(24).toString("base64url");
    this.targets.set(key, target);
    return { key, url: `http://127.0.0.1:${this.port}/mcp/${key}` };
  }

  unregister(key: string) {
    this.targets.delete(key);
  }

  close() {
    this.server?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const m = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url ?? "/", "http://x").pathname);
    const target = m ? this.targets.get(m[1]) : undefined;
    if (!target) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      // Modo sin estado: no hay stream SSE de servidor ni sesiones MCP que cerrar.
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
      if (process.env.RELAY_DEBUG_MCP) target.log(`MCP ← ${JSON.stringify(body).slice(0, 400)}`);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const server = buildMcpServer(target);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      target.log(`error en el servidor MCP del puente: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ─── Herramientas ────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text: truncate(text) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [salida truncada: ${text.length - MAX_TOOL_OUTPUT} caracteres más]`;
}

export function buildMcpServer(t: BridgeTarget): McpServer {
  const server = new McpServer(
    { name: BRIDGE_SERVER_NAME, version: packageVersion() },
    {
      instructions: t.localSep === "\\"
        ? `${BRIDGE_INSTRUCTIONS}\nThe user's machine runs Windows: bash runs Windows PowerShell, so write PowerShell commands, and file paths on that machine use backslashes.`
        : BRIDGE_INSTRUCTIONS,
    },
  );
  const io = new BridgeIO(t);

  const guarded =
    <A>(name: string, fn: (args: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        t.log(`puente ${name} falló: ${(err as Error).message}`);
        return fail(`Error: ${(err as Error).message}`);
      }
    };

  server.registerTool(
    "read",
    {
      description:
        "Read a text file from the user's project (no approval needed; prefer it over bash cat/head/tail). Returns lines prefixed with their line number (cat -n format). Use offset/limit for large files.",
      inputSchema: {
        path: z.string().optional().describe("Absolute path or path relative to the working directory"),
        file_path: z.string().optional().describe("Alias of path"),
        offset: z.number().int().positive().optional().describe("1-based line to start from"),
        limit: z.number().int().positive().optional().describe(`Number of lines to read (default ${DEFAULT_READ_LINES})`),
      },
      annotations: { readOnlyHint: true },
    },
    guarded("read", async ({ path: pathArg, file_path, offset, limit }) => {
      const p = requirePath(pathArg, file_path);
      const start = offset ?? 1;
      const { content } = await io.fs<{ content: string }>("fs/read_text_file", {
        path: io.toLocal(p),
        line: start,
        limit: limit ?? DEFAULT_READ_LINES,
      });
      if (content === "") return ok("(archivo vacío)");
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      return ok(
        lines
          .map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l}`)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "write",
    {
      description: "Create or overwrite a file in the user's project with the given content. Parent directories are created.",
      inputSchema: {
        path: z.string().optional().describe("Absolute path or path relative to the working directory"),
        file_path: z.string().optional().describe("Alias of path"),
        content: z.string(),
      },
      annotations: { destructiveHint: true },
    },
    guarded("write", async ({ path: pathArg, file_path, content }) => {
      const p = requirePath(pathArg, file_path);
      await io.fs("fs/write_text_file", { path: io.toLocal(p), content });
      return ok(`Escrito ${p} (${content.length} caracteres)`);
    }),
  );

  server.registerTool(
    "edit",
    {
      description:
        "Replace an exact string in a file of the user's project. old_string must match exactly (no line-number prefixes) and be unique unless replace_all is true.",
      inputSchema: {
        path: z.string().optional(),
        file_path: z.string().optional().describe("Alias of path"),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    guarded("edit", async ({ path: pathArg, file_path, old_string, new_string, replace_all }) => {
      const p = requirePath(pathArg, file_path);
      const local = io.toLocal(p);
      const { content } = await io.fs<{ content: string }>("fs/read_text_file", { path: local, _meta: { relay: { hidden: true } } });
      const count = content.split(old_string).length - 1;
      if (count === 0) return fail(`old_string no aparece en ${p}`);
      if (count > 1 && !replace_all) {
        return fail(`old_string aparece ${count} veces en ${p}; agrega más contexto o usa replace_all`);
      }
      const updated = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, () => new_string);
      await io.fs("fs/write_text_file", { path: local, content: updated, _meta: { relay: { kind: "edit" } } });
      return ok(`Editado ${p} (${replace_all ? count : 1} reemplazo(s))`);
    }),
  );

  server.registerTool(
    "bash",
    {
      description:
        `Run a program on the user's machine, in the project root, with ${io.windows ? "Windows PowerShell (use PowerShell syntax, not bash)" : "POSIX sh"}: builds, tests, linters, package managers, git. Requires the user's approval. Do not use it to read, list or search files (use read, glob, grep) or to modify files (use edit, write). Returns combined stdout/stderr and the exit code.`,
      inputSchema: {
        command: z.string().min(1),
        timeout_ms: z.number().int().positive().max(MAX_BASH_TIMEOUT_MS).optional(),
        timeout: z.number().int().positive().max(MAX_BASH_TIMEOUT_MS).optional().describe("Alias of timeout_ms"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guarded("bash", async ({ command, timeout_ms, timeout }) => {
      const r = await io.shell(command, timeout_ms ?? timeout ?? DEFAULT_BASH_TIMEOUT_MS);
      const status = r.timedOut ? "tiempo agotado, proceso detenido" : `código de salida ${r.exitCode ?? r.signal ?? "?"}`;
      return ok(`${io.toRemoteText(r.output) || "(sin salida)"}\n[${status}${r.truncated ? ", salida truncada" : ""}]`);
    }),
  );

  server.registerTool(
    "grep",
    {
      description:
        "Search file contents in the user's project with a regular expression (no approval needed; prefer it over bash grep/rg). Uses ripgrep if installed, otherwise grep. Returns path:line:text matches.",
      inputSchema: {
        pattern: z.string().min(1),
        path: z.string().optional().describe("Folder or file to search (default: project root)"),
        glob: z.string().optional().describe('Filter files, e.g. "*.ts"'),
        ignore_case: z.boolean().optional(),
        files_only: z.boolean().optional().describe("Return only file names"),
        max_results: z.number().int().positive().max(5000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded("grep", async ({ pattern, path: p, glob, ignore_case, files_only, max_results }) => {
      const cmd = buildGrepCommand(
        { pattern, path: io.toLocal(p ?? "."), glob, ignoreCase: ignore_case, filesOnly: files_only, max: max_results ?? 500 },
        io.windows,
      );
      const where = p ? ` en ${p}` : "";
      const r = await io.shell(cmd, DEFAULT_BASH_TIMEOUT_MS, { kind: "search", detail: `'${pattern}'${where}${glob ? ` (${glob})` : ""}` });
      return ok(io.toRemoteText(r.output).trim() || "Sin coincidencias");
    }),
  );

  server.registerTool(
    "glob",
    {
      description:
        'List files in the user\'s project matching a glob pattern such as "**/*" or "src/**/*.java" (no approval needed; prefer it over bash ls/find). Respects .gitignore when ripgrep is installed.',
      inputSchema: {
        pattern: z.string().min(1),
        path: z.string().optional().describe("Folder to search (default: project root)"),
        max_results: z.number().int().positive().max(10000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded("glob", async ({ pattern, path: p, max_results }) => {
      const cmd = buildGlobCommand({ pattern, path: io.toLocal(p ?? "."), max: max_results ?? 1000 }, io.windows);
      const r = await io.shell(cmd, DEFAULT_BASH_TIMEOUT_MS, { kind: "list", detail: `${pattern}${p ? ` en ${p}` : ""}` });
      return ok(io.toRemoteText(r.output).trim() || "Sin archivos");
    }),
  );

  return server;
}

/**
 * Los agentes suelen usar los nombres de parámetro de sus herramientas internas
 * (p. ej. `file_path` en Claude Code). Se aceptan ambos para no gastar turnos.
 */
function requirePath(pathArg?: string, filePath?: string): string {
  const p = pathArg ?? filePath;
  if (!p) throw new Error("falta el parámetro path");
  return p;
}

/** Comillas simples POSIX. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Comillas simples de PowerShell (la comilla se escapa duplicándola). */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const PS_EXCLUDED = `Where-Object { $_.FullName -notmatch '[\\\\/](\\.git|node_modules)[\\\\/]' }`;

export interface GrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  ignoreCase?: boolean;
  filesOnly?: boolean;
  max: number;
}

/** grep del puente: ripgrep si existe; si no, grep (POSIX) o Select-String (PowerShell). */
export function buildGrepCommand(o: GrepOptions, windows: boolean): string {
  if (!windows) {
    const target = q(o.path);
    const i = o.ignoreCase ? "-i" : "";
    const l = o.filesOnly ? "-l" : "-n";
    const rg = `rg ${l} --no-heading --color never ${i} ${o.glob ? `-g ${q(o.glob)}` : ""} -e ${q(o.pattern)} -- ${target}`;
    const gr = `grep -rE ${l} ${i} ${o.glob ? `--include=${q(o.glob)}` : ""} --exclude-dir=.git --exclude-dir=node_modules -e ${q(o.pattern)} -- ${target}`;
    return `if command -v rg >/dev/null 2>&1; then ${rg}; else ${gr}; fi | head -n ${o.max}`;
  }
  const rgArgs = [o.filesOnly ? "-l" : "-n", "--no-heading", "--color", "never"];
  if (o.ignoreCase) rgArgs.push("-i");
  if (o.glob) rgArgs.push("-g", psq(o.glob));
  // Windows PowerShell 5.1 descarta "--" al invocar ejecutables nativos; las rutas absolutas
  // de Windows nunca empiezan con "-", así que no hace falta.
  const rg = `rg ${rgArgs.join(" ")} -e ${psq(o.pattern)} ${psq(o.path)}`;
  const files = `Get-ChildItem -Path ${psq(o.path)} -Recurse -File${o.glob ? ` -Include ${psq(o.glob)}` : ""} -ErrorAction SilentlyContinue | ${PS_EXCLUDED}`;
  const select = `Select-String -Pattern ${psq(o.pattern)}${o.ignoreCase ? "" : " -CaseSensitive"}${o.filesOnly ? " -List" : ""}`;
  const format = o.filesOnly ? "ForEach-Object { $_.Path }" : "ForEach-Object { '{0}:{1}:{2}' -f $_.Path, $_.LineNumber, $_.Line }";
  return `& { if (Get-Command rg -ErrorAction SilentlyContinue) { ${rg} } else { ${files} | ${select} | ${format} } } | Select-Object -First ${o.max}`;
}

export interface GlobOptions {
  pattern: string;
  path: string;
  max: number;
}

/** glob del puente: ripgrep si existe; si no, find (POSIX) o Get-ChildItem (PowerShell). */
export function buildGlobCommand(o: GlobOptions, windows: boolean): string {
  const base = o.pattern.split("/").pop() ?? o.pattern;
  if (!windows) {
    const target = q(o.path);
    const rg = `rg --files --color never -g ${q(o.pattern)} -- ${target}`;
    const fd = `find ${target} -type f -name ${q(base)} -not -path '*/.git/*' -not -path '*/node_modules/*'`;
    return `if command -v rg >/dev/null 2>&1; then ${rg}; else ${fd}; fi | head -n ${o.max}`;
  }
  const rg = `rg --files --color never -g ${psq(o.pattern)} ${psq(o.path)}`;
  const gci = `Get-ChildItem -Path ${psq(o.path)} -Recurse -File -Filter ${psq(base)} -ErrorAction SilentlyContinue | ${PS_EXCLUDED} | ForEach-Object { $_.FullName }`;
  return `& { if (Get-Command rg -ErrorAction SilentlyContinue) { ${rg} } else { ${gci} } } | Select-Object -First ${o.max}`;
}

class BridgeIO {
  constructor(private t: BridgeTarget) {}

  get windows() {
    return this.t.localSep === "\\";
  }


  /** Ruta que da el agente (espejo remoto o relativa) → ruta en la máquina local. */
  toLocal(p: string): string {
    const { remoteRoot, localRoot, localSep } = this.t;
    const abs = path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : path.posix.join(remoteRoot, p);
    if (abs === remoteRoot || abs.startsWith(remoteRoot + "/")) {
      return rewritePathPrefix(abs, remoteRoot, localRoot, "/", localSep);
    }
    return abs; // ya es local o está fuera del proyecto: el CLI decide
  }

  /** Texto con rutas locales → rutas del espejo, para que el agente siga coherente. */
  toRemoteText(s: string): string {
    return rewritePathPrefix(s, this.t.localRoot, this.t.remoteRoot, this.t.localSep, "/");
  }

  async fs<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const sessionId = await this.t.sessionId;
    this.t.log(`puente → ${method} ${String(params.path ?? "")}`);
    return this.t.requester.request<T>(method, { sessionId, ...params });
  }

  /** `display` le dice al CLI cómo mostrar la operación (ver RelayDisplayMeta). */
  async shell(command: string, timeoutMs: number, display?: { kind: string; detail: string }) {
    const sessionId = await this.t.sessionId;
    const [cmd, args] = this.windows
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]]
      : ["/bin/sh", ["-c", command]];
    this.t.log(`puente → terminal ${command.length > 120 ? `${command.slice(0, 120)}…` : command}`);

    const { terminalId } = await this.t.requester.request<{ terminalId: string }>("terminal/create", {
      sessionId,
      command: cmd,
      args,
      cwd: this.t.localRoot,
      outputByteLimit: MAX_TOOL_OUTPUT * 2,
      ...(display ? { _meta: { relay: display } } : {}),
    });
    const base = { sessionId, terminalId };

    try {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        this.t.requester.request("terminal/wait_for_exit", base, timeoutMs + 30_000).then(() => false),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), timeoutMs))),
      ]);
      clearTimeout(timer);
      if (timedOut) await this.t.requester.request("terminal/kill", base).catch(() => undefined);
      const out = await this.t.requester.request<{
        output: string;
        truncated: boolean;
        exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
      }>("terminal/output", base);
      return {
        output: out.output,
        truncated: out.truncated,
        exitCode: out.exitStatus?.exitCode ?? null,
        signal: out.exitStatus?.signal ?? null,
        timedOut,
      };
    } finally {
      await this.t.requester.request("terminal/release", base).catch(() => undefined);
    }
  }
}
