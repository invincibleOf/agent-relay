import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const expandHome = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);

const InstructionAlias = z.object({
  /** Ruta relativa dentro del workspace espejo (p. ej. CLAUDE.md). */
  path: z.string(),
  /** Contenido que se escribe; por defecto importa AGENTS.md. */
  content: z.string().default("@AGENTS.md\n"),
});

const Provider = z.object({
  /** Ejecutable del adaptador ACP (npx, opencode, una ruta absoluta...). */
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Variables de entorno extra; aquí viven las credenciales del proveedor. */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * Carpetas donde este proveedor busca skills. El daemon las enlaza a
   * `.agents/skills` del workspace espejo (formato abierto Agent Skills).
   */
  skillsDirs: z.array(z.string()).default([]),
  /** Archivos de instrucciones propios del proveedor que apuntan a AGENTS.md. */
  instructionAliases: z.array(InstructionAlias).default([]),
  /**
   * Puente de herramientas: el daemon ofrece al agente un servidor MCP cuyas
   * herramientas (read, write, edit, bash, grep, glob) se ejecutan en la
   * máquina del CLI.
   */
  toolBridge: z
    .object({
      enabled: z.boolean().default(true),
      /** Cómo desactivar las herramientas internas del agente ("none" = no tocarlas). */
      preset: z.enum(["claude-code", "none"]).default("none"),
      /** `_meta` adicional que se mezcla en session/new, load y resume. */
      sessionMeta: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ enabled: true, preset: "none", sessionMeta: {} }),
});

const DaemonConfig = z.object({
  listen: z
    .object({
      /** Escucha solo en la interfaz de la VPN (Tailscale/WireGuard) o en la LAN. */
      host: z.string().default("127.0.0.1"),
      port: z.number().int().positive().default(7443),
    })
    .default({ host: "127.0.0.1", port: 7443 }),
  tls: z
    .object({
      cert: z.string().transform(expandHome),
      key: z.string().transform(expandHome),
      /** Si se define, el daemon exige certificado de cliente (mTLS). */
      clientCa: z.string().transform(expandHome).optional(),
    })
    .optional(),
  auth: z.object({
    /** Hashes SHA-256 (hex) de los tokens aceptados. Genera uno con `relay-daemon gen-token`. */
    tokenSha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
  }),
  workspacesDir: z.string().default("~/.local/share/agent-relay/workspaces").transform(expandHome),
  defaultProvider: z.string(),
  providers: z.record(z.string(), Provider),
});

export type DaemonConfig = z.infer<typeof DaemonConfig>;
export type ProviderConfig = z.infer<typeof Provider>;

export function defaultDaemonConfigPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "agent-relay", "daemon.yaml");
}

export function loadDaemonConfig(file: string): DaemonConfig {
  const raw = YAML.parse(readFileSync(file, "utf8"));
  const cfg = DaemonConfig.parse(raw);
  if (!cfg.providers[cfg.defaultProvider]) {
    throw new Error(`defaultProvider "${cfg.defaultProvider}" no está definido en providers`);
  }
  return cfg;
}
