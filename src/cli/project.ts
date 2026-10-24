import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { ProjectFile } from "../shared/protocol.js";

/** Formatos abiertos que el CLI sincroniza hacia el workspace espejo. */
export const OPEN_FORMAT_DIR = ".agents"; // .agents/skills, .agents/commands
export const INSTRUCTIONS_FILE = "AGENTS.md";

const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB por archivo
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MiB en total
const MAX_DEPTH = 8;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".venv", "venv", "__pycache__"]);

/** Archivos específicos de un proveedor que nunca deben vivir en el proyecto. */
export const PROVIDER_SPECIFIC_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude", ".codex", ".opencode"];

/** Busca la raíz del proyecto subiendo desde `start` hasta encontrar .git o AGENTS.md. */
export function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, INSTRUCTIONS_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function projectId(root: string): string {
  return createHash("sha256").update(`${hostname()}:${root}`).digest("hex").slice(0, 16);
}

/**
 * Reúne los archivos en formato abierto del proyecto:
 *   - todos los AGENTS.md (raíz y subcarpetas)
 *   - todo lo que haya bajo .agents/ (skills y comandos)
 */
export function collectProjectFiles(root: string): { files: ProjectFile[]; warnings: string[] } {
  const files: ProjectFile[] = [];
  const warnings: string[] = [];
  let total = 0;

  const add = (abs: string) => {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const size = statSync(abs).size;
    if (size > MAX_FILE_BYTES) {
      warnings.push(`${rel} omitido (supera ${MAX_FILE_BYTES} bytes)`);
      return;
    }
    if (total + size > MAX_TOTAL_BYTES) {
      warnings.push(`${rel} omitido (límite total de ${MAX_TOTAL_BYTES} bytes)`);
      return;
    }
    total += size;
    files.push({ path: rel, contentBase64: readFileSync(abs).toString("base64") });
  };

  const walk = (dir: string, depth: number, inAgentsDir: boolean) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const enteringAgents = inAgentsDir || (dir === root && entry.name === OPEN_FORMAT_DIR);
        walk(abs, depth + 1, enteringAgents);
      } else if (entry.isFile()) {
        if (inAgentsDir || entry.name === INSTRUCTIONS_FILE) add(abs);
      }
    }
  };

  walk(root, 0, false);

  for (const name of PROVIDER_SPECIFIC_FILES) {
    if (existsSync(path.join(root, name))) {
      warnings.push(
        `Se encontró "${name}" en el proyecto. Es un archivo atado a un proveedor; mueve su contenido a AGENTS.md o .agents/ para mantenerlo portable.`,
      );
    }
  }

  return { files, warnings };
}
