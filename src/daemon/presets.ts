/**
 * Cómo pedirle a cada agente que use las herramientas del puente en lugar de
 * las suyas. Es lo único específico de cada proveedor en el puente, y vive solo
 * en el daemon.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const BRIDGE_SERVER_NAME = "relay";

/** Herramientas del puente que no modifican nada (se pueden aprobar solas). */
export const READ_ONLY_TOOLS = ["read", "grep", "glob"] as const;

export const BRIDGE_INSTRUCTIONS = `The user's project lives on a different machine than the one you run on. Your working directory is only a mirror that holds AGENTS.md and the project's skills; the real source files are not there.
Use the tools of the "${BRIDGE_SERVER_NAME}" MCP server for every file and shell operation. They act on the user's real project. Paths may be absolute (under your working directory) or relative to it; they are mapped to the user's project automatically.
Choose the tool by purpose:
- To explore or understand code, use only read, glob and grep. They run without asking the user for approval. Do not use bash for cat, head, tail, ls, find, grep, rg or wc.
- To change files, use edit for targeted changes and write for new files or full rewrites. Do not use bash with sed, echo or redirections to modify files.
- Use bash only to run programs: builds, tests, linters, package managers, git and the project's own scripts. Every bash call needs the user's approval, so batch related steps and avoid speculative commands.`;

export type PresetName = "claude-code" | "opencode" | "none";

/** Herramientas internas de OpenCode que tocan disco o shell. */
const OPENCODE_BUILTIN_TOOLS = ["bash", "read", "write", "edit", "multiedit", "patch", "apply_patch", "grep", "glob", "list"];
/** Herramientas del puente que modifican algo: OpenCode debe pedir permiso. */
const MUTATING_TOOLS = ["write", "edit", "bash"];

/**
 * Variables de entorno para el proceso del agente. Para OpenCode, que no lee
 * `_meta` de ACP, el preset viaja como OPENCODE_CONFIG_CONTENT (configuración
 * en línea que se mezcla sobre la del proyecto y la global).
 */
export function presetSpawnEnv(
  preset: PresetName,
  remoteRoot: string,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (preset !== "opencode") return {};

  const instructionsFile = path.join(remoteRoot, ".relay", "bridge-instructions.md");
  mkdirSync(path.dirname(instructionsFile), { recursive: true });
  writeFileSync(instructionsFile, `# agent-relay\n\n${BRIDGE_INSTRUCTIONS}\n`);

  const presetConfig = {
    tools: Object.fromEntries(OPENCODE_BUILTIN_TOOLS.map((t) => [t, false])),
    permission: Object.fromEntries(MUTATING_TOOLS.map((t) => [`${BRIDGE_SERVER_NAME}_${t}`, "ask"])),
    instructions: [instructionsFile],
  };

  let userConfig: unknown = {};
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      userConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    } catch {
      throw new Error("OPENCODE_CONFIG_CONTENT del proveedor no es JSON válido");
    }
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(deepMerge(userConfig, presetConfig)) };
}

/** `_meta` que se mezcla en session/new, session/load y session/resume. */
export function presetSessionMeta(preset: PresetName): Record<string, unknown> {
  switch (preset) {
    case "claude-code":
      return {
        systemPrompt: { append: BRIDGE_INSTRUCTIONS },
        claudeCode: {
          options: {
            // Herramientas internas que tocan disco o shell: quedan fuera, así
            // que la única forma de actuar es a través del puente.
            disallowedTools: [
              "Read",
              "Write",
              "Edit",
              "MultiEdit",
              "NotebookEdit",
              "Bash",
              "BashOutput",
              "KillBash",
              "KillShell",
              "PowerShell",
              "Monitor",
              "Glob",
              "Grep",
              "LS",
            ],
            allowedTools: READ_ONLY_TOOLS.map((t) => `mcp__${BRIDGE_SERVER_NAME}__${t}`),
          },
        },
      };
    case "opencode": // OpenCode se configura por entorno (presetSpawnEnv)
    case "none":
      return {};
  }
}

/** Mezcla profunda de objetos planos; los arrays se concatenan sin duplicados. */
export function deepMerge(base: unknown, extra: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(extra)) return [...new Set([...base, ...extra])];
  if (isPlainObject(base) && isPlainObject(extra)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(extra)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return extra === undefined ? base : extra;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
