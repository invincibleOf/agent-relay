import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectFile } from "../shared/protocol.js";
import type { ProviderConfig } from "./config.js";

const MANIFEST = ".relay-manifest.json";
const OPEN_SKILLS_DIR = ".agents/skills";

/**
 * Valida una ruta relativa recibida del CLI antes de escribirla en el disco del
 * daemon: nada absoluto, nada de "..", nada fuera del workspace.
 */
export function safeRelativePath(rel: string, root: string): string {
  if (rel.length === 0 || rel.includes("\0")) throw new Error(`Ruta inválida: ${JSON.stringify(rel)}`);
  const normalized = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new Error(`Ruta fuera del workspace: ${rel}`);
  }
  const abs = path.resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Ruta fuera del workspace: ${rel}`);
  return abs;
}

/**
 * Prepara el workspace espejo de un proyecto para un proveedor:
 *   1. Escribe AGENTS.md y .agents/** tal como vienen del proyecto local.
 *   2. Enlaza las carpetas de skills propias del proveedor a .agents/skills.
 *   3. Crea los alias de instrucciones del proveedor (p. ej. CLAUDE.md → @AGENTS.md).
 *
 * Los archivos atados a un proveedor solo existen aquí, nunca en tu máquina.
 * El directorio lo controla el daemon; los archivos de una sincronización
 * anterior que ya no existen en el proyecto se eliminan.
 */
export function materializeWorkspace(
  workspacesDir: string,
  projectId: string,
  providerName: string,
  provider: ProviderConfig,
  files: ProjectFile[],
): string {
  if (!/^[0-9a-f]{8,64}$/.test(projectId)) throw new Error("projectId inválido");
  if (!/^[A-Za-z0-9_-]+$/.test(providerName)) throw new Error("Nombre de proveedor inválido");

  const root = path.resolve(workspacesDir, projectId, providerName);
  mkdirSync(root, { recursive: true });

  const previous = readManifest(root);
  const written = new Set<string>();

  for (const file of files) {
    const abs = safeRelativePath(file.path, root);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(file.contentBase64, "base64"));
    written.add(path.relative(root, abs));
  }

  // Skills: cada carpeta del proveedor es un enlace a .agents/skills.
  const skillsTarget = path.join(root, OPEN_SKILLS_DIR);
  const hasSkills = existsSync(skillsTarget);
  for (const dir of provider.skillsDirs) {
    const link = safeRelativePath(dir, root);
    if (path.relative(root, link) === OPEN_SKILLS_DIR) continue; // el proveedor ya lee el formato abierto
    removeIfExists(link);
    if (!hasSkills) continue;
    mkdirSync(path.dirname(link), { recursive: true });
    // En Windows una junction no requiere permisos de administrador (necesita ruta absoluta).
    if (process.platform === "win32") symlinkSync(skillsTarget, link, "junction");
    else symlinkSync(path.relative(path.dirname(link), skillsTarget), link, "dir");
    written.add(path.relative(root, link));
  }

  // Alias de instrucciones (solo si el proyecto trae AGENTS.md).
  const hasInstructions = existsSync(path.join(root, "AGENTS.md"));
  for (const alias of provider.instructionAliases) {
    const abs = safeRelativePath(alias.path, root);
    removeIfExists(abs);
    if (!hasInstructions) continue;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, alias.content);
    written.add(path.relative(root, abs));
  }

  // Limpia lo que sobró de la sincronización anterior.
  for (const rel of previous) {
    if (written.has(rel)) continue;
    try {
      removeIfExists(safeRelativePath(rel, root));
    } catch {
      /* rutas viejas inválidas: se ignoran */
    }
  }

  writeFileSync(path.join(root, MANIFEST), JSON.stringify([...written].sort(), null, 2));
  return root;
}

function readManifest(root: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, MANIFEST), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function removeIfExists(abs: string) {
  try {
    lstatSync(abs);
  } catch {
    return;
  }
  rmSync(abs, { recursive: true, force: true });
}
