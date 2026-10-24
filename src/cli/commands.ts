import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { configDir } from "./config.js";

/**
 * Comandos personalizados en formato abierto, al estilo de OpenCode:
 *
 *   .agents/commands/<nombre>.md            (del proyecto)
 *   ~/.config/agent-relay/commands/<nombre>.md  (globales)
 *
 * Frontmatter YAML opcional (`description`) y un cuerpo que es la plantilla
 * del prompt. Marcadores: $ARGUMENTS (todo el texto) y $1…$9 (por palabra).
 * El CLI expande el comando localmente y envía el texto resultante como
 * prompt, así que funciona igual con cualquier proveedor.
 */
export interface CustomCommand {
  name: string;
  description: string;
  template: string;
  source: "proyecto" | "global";
}

export function loadCustomCommands(projectRoot: string): Map<string, CustomCommand> {
  const map = new Map<string, CustomCommand>();
  const load = (dir: string, source: CustomCommand["source"]) => {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const name = file.slice(0, -3);
      if (!/^[A-Za-z0-9][\w-]*$/.test(name)) continue;
      const raw = readFileSync(path.join(dir, file), "utf8");
      const { meta, body } = splitFrontmatter(raw);
      map.set(name, {
        name,
        description: typeof meta.description === "string" ? meta.description : "",
        template: body.trim(),
        source,
      });
    }
  };
  load(path.join(configDir(), "commands"), "global");
  load(path.join(projectRoot, ".agents", "commands"), "proyecto"); // el proyecto gana
  return map;
}

export function expandTemplate(template: string, args: string): string {
  const words = args.trim().length ? args.trim().split(/\s+/) : [];
  return template
    .replace(/\$ARGUMENTS/g, args.trim())
    .replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? "");
}

function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  try {
    const meta = YAML.parse(m[1]);
    return { meta: meta && typeof meta === "object" ? meta : {}, body: m[2] };
  } catch {
    return { meta: {}, body: m[2] };
  }
}

/** Prompt del comando integrado /init: crea o mejora AGENTS.md en formato abierto. */
export const INIT_PROMPT = `Analiza este proyecto (estructura, lenguajes, cómo se compila, cómo se prueba, convenciones de código) y crea o actualiza el archivo AGENTS.md en la raíz.

Reglas:
- Usa el formato abierto AGENTS.md (https://agents.md): Markdown simple, secciones cortas y concretas.
- Incluye: descripción breve, comandos de build/test/lint, estructura de carpetas, convenciones y cosas a evitar.
- No crees archivos específicos de un proveedor (CLAUDE.md, .claude/, .codex/, .opencode/).
- Si AGENTS.md ya existe, conserva lo útil y mejóralo en lugar de reescribirlo desde cero.`;
