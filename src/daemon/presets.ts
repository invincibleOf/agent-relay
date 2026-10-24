/**
 * Cómo pedirle a cada agente que use las herramientas del puente en lugar de
 * las suyas. Es lo único específico de cada proveedor en el puente, y vive solo
 * en el daemon.
 */

export const BRIDGE_SERVER_NAME = "relay";

/** Herramientas del puente que no modifican nada (se pueden aprobar solas). */
export const READ_ONLY_TOOLS = ["read", "grep", "glob"] as const;

export const BRIDGE_INSTRUCTIONS = `The user's project lives on a different machine than the one you run on. Your working directory is only a mirror that holds AGENTS.md and the project's skills; the real source files are not there.
Use the tools of the "${BRIDGE_SERVER_NAME}" MCP server for every file and shell operation: read, write, edit, grep, glob and bash. They act on the user's real project. Paths may be absolute (under your working directory) or relative to it; they are mapped to the user's project automatically.`;

export type PresetName = "claude-code" | "none";

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
