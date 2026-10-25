import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

interface Terminal {
  proc: ChildProcess;
  output: Buffer;
  truncated: boolean;
  limit: number;
  exit: Promise<WaitForTerminalExitResponse>;
  exitStatus?: WaitForTerminalExitResponse;
}

/** Muestra el comando real cuando viene envuelto en un shell (`sh -c …`, `cmd /c …`). */
export function displayCommand(command: string, args: string[]): string {
  const shells = /(^|[\\/])(sh|bash|zsh|cmd(\.exe)?)$/i;
  const last = args.at(-1);
  const wrapped = shells.test(command) && last !== undefined && args.slice(0, -1).every((a) => /^[-/]/.test(a));
  const text = wrapped ? last : [command, ...args].join(" ");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

export type LocalActivityKind = "read" | "write" | "edit" | "exec" | "search" | "list";
export type LocalActivity = (kind: LocalActivityKind, detail: string) => void;

/**
 * El daemon puede describir cómo mostrar una operación del puente en
 * `_meta.relay` (p. ej. "busca 'x'" en lugar del comando rg completo, u
 * ocultar la lectura interna de un edit).
 */
interface RelayDisplayMeta {
  hidden?: boolean;
  kind?: LocalActivityKind;
  detail?: string;
}
function relayMeta(meta: unknown): RelayDisplayMeta | undefined {
  const r = (meta as { relay?: unknown } | null | undefined)?.relay;
  return r && typeof r === "object" ? (r as RelayDisplayMeta) : undefined;
}

/**
 * Implementa en la máquina local las capacidades de cliente de ACP:
 * lectura/escritura de archivos y terminales. Es la mitad "local" del
 * sistema: el agente piensa en la máquina remota y actúa aquí.
 *
 * Todo acceso queda limitado a la raíz del proyecto (y a extraRoots).
 */
export class LocalTools {
  private terminals = new Map<string, Terminal>();
  private roots: string[];

  constructor(
    projectRoot: string,
    extraRoots: string[],
    private onActivity: LocalActivity,
  ) {
    this.roots = [projectRoot, ...extraRoots].map((r) => path.resolve(r));
  }

  private ensureAllowed(p: string): string {
    if (!path.isAbsolute(p)) throw RequestError.invalidParams({ path: p }, "La ruta debe ser absoluta");
    const abs = path.resolve(p);
    const ok = this.roots.some((root) => abs === root || abs.startsWith(root + path.sep));
    if (!ok) {
      throw RequestError.invalidParams({ path: p }, `Acceso denegado: ${p} está fuera del proyecto`);
    }
    return abs;
  }

  async readTextFile(req: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const abs = this.ensureAllowed(req.path);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw RequestError.resourceNotFound(req.path);
      throw err;
    }
    if (req.line != null || req.limit != null) {
      const lines = content.split("\n");
      const start = Math.max(0, (req.line ?? 1) - 1);
      const end = req.limit != null ? start + req.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    this.report(req._meta, "read", this.display(abs));
    return { content };
  }

  async writeTextFile(req: WriteTextFileRequest): Promise<Record<string, never>> {
    const abs = this.ensureAllowed(req.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, req.content, "utf8");
    this.report(req._meta, "write", this.display(abs));
    return {};
  }

  async createTerminal(req: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const cwd = req.cwd ? this.ensureAllowed(req.cwd) : this.roots[0];
    const env = { ...process.env };
    for (const v of req.env ?? []) env[v.name] = v.value;

    const args = req.args ?? [];
    // Sin argumentos y con espacios, el agente envió una línea de shell completa.
    const useShell = args.length === 0 && /\s/.test(req.command);
    const proc = spawn(req.command, args, { cwd, env, shell: useShell, stdio: ["ignore", "pipe", "pipe"] });

    const id = randomUUID();
    const term: Terminal = {
      proc,
      output: Buffer.alloc(0),
      truncated: false,
      limit: req.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
      exit: new Promise((resolve) => {
        proc.on("error", (err) => {
          const status = { exitCode: 127, signal: null };
          term.output = Buffer.concat([term.output, Buffer.from(`\n${err.message}\n`)]);
          term.exitStatus = status;
          resolve(status);
        });
        proc.on("close", (code, signal) => {
          const status = { exitCode: code, signal: signal ?? null };
          term.exitStatus = status;
          resolve(status);
        });
      }),
    };

    const append = (chunk: Buffer) => {
      let out = Buffer.concat([term.output, chunk]);
      if (out.length > term.limit) {
        // La especificación pide truncar desde el inicio, conservando lo más reciente.
        out = out.subarray(out.length - term.limit);
        term.truncated = true;
      }
      term.output = out;
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);

    this.terminals.set(id, term);
    this.report(req._meta, "exec", displayCommand(req.command, args));
    return { terminalId: id };
  }

  private terminal(id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t) throw RequestError.invalidParams({ terminalId: id }, "Terminal desconocida");
    return t;
  }

  async terminalOutput(req: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const t = this.terminal(req.terminalId);
    return { output: t.output.toString("utf8"), truncated: t.truncated, exitStatus: t.exitStatus ?? null };
  }

  async waitForExit(req: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.terminal(req.terminalId).exit;
  }

  async kill(req: KillTerminalRequest): Promise<Record<string, never>> {
    const t = this.terminal(req.terminalId);
    if (!t.exitStatus) t.proc.kill("SIGTERM");
    return {};
  }

  async release(req: ReleaseTerminalRequest): Promise<Record<string, never>> {
    const t = this.terminals.get(req.terminalId);
    if (t && !t.exitStatus) t.proc.kill("SIGTERM");
    this.terminals.delete(req.terminalId);
    return {};
  }

  disposeAll() {
    for (const t of this.terminals.values()) if (!t.exitStatus) t.proc.kill("SIGTERM");
    this.terminals.clear();
  }

  private report(meta: unknown, kind: LocalActivityKind, detail: string) {
    const m = relayMeta(meta);
    if (m?.hidden) return;
    this.onActivity(m?.kind ?? kind, m?.detail ?? detail);
  }

  private display(abs: string): string {
    const rel = path.relative(this.roots[0], abs);
    return rel.startsWith("..") ? abs : rel || ".";
  }
}
