import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const expandHome = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);

const Host = z.object({
  /** ws://… o wss://…, normalmente la IP/nombre de Tailscale del daemon, terminando en /acp. */
  url: z.string().regex(/^wss?:\/\//),
  /** Token en texto plano (mejor usar tokenEnv o tokenFile). */
  token: z.string().optional(),
  /** Variable de entorno de donde leer el token. */
  tokenEnv: z.string().optional(),
  /** Archivo de donde leer el token. */
  tokenFile: z.string().transform(expandHome).optional(),
  /** CA para validar el certificado del daemon (si usa TLS con CA propia). */
  ca: z.string().transform(expandHome).optional(),
  /** Certificado y llave de cliente para mTLS. */
  cert: z.string().transform(expandHome).optional(),
  key: z.string().transform(expandHome).optional(),
  /** Proveedor por defecto para este host; si se omite, decide el daemon. */
  provider: z.string().optional(),
});

const CliConfig = z.object({
  defaultHost: z.string().optional(),
  hosts: z.record(z.string(), Host).default({}),
  permissions: z
    .object({
      /** Aprueba automáticamente lo que pida el agente (equivale a --yes). */
      autoApprove: z.boolean().default(false),
      /** Rutas absolutas extra (fuera del proyecto) que el agente puede leer y escribir. */
      extraRoots: z.array(z.string().transform(expandHome)).default([]),
    })
    .default({ autoApprove: false, extraRoots: [] }),
});

export type HostConfig = z.infer<typeof Host>;
export type CliConfig = z.infer<typeof CliConfig>;

export function configDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "agent-relay");
}

export function defaultCliConfigPath(): string {
  return path.join(configDir(), "cli.yaml");
}

export function loadCliConfig(file: string): CliConfig {
  if (!existsSync(file)) return CliConfig.parse({});
  return CliConfig.parse(YAML.parse(readFileSync(file, "utf8")) ?? {});
}

export interface ResolvedHost {
  name: string;
  url: string;
  token: string;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  provider?: string;
}

/**
 * Resuelve el host a usar. Prioridad: --url/RELAY_URL, luego --host, luego defaultHost.
 * El token nunca se toma de un proveedor de IA: solo autentica contra tu daemon.
 */
export function resolveHost(cfg: CliConfig, hostName?: string, urlOverride?: string): ResolvedHost {
  const url = urlOverride ?? process.env.RELAY_URL;
  if (url) {
    const token = process.env.RELAY_TOKEN;
    if (!token) throw new Error("Con --url o RELAY_URL debes definir RELAY_TOKEN");
    return { name: "url", url, token };
  }

  const name = hostName ?? cfg.defaultHost ?? Object.keys(cfg.hosts)[0];
  if (!name) {
    throw new Error(`No hay hosts configurados. Crea ${defaultCliConfigPath()} (ver examples/cli.yaml) o usa RELAY_URL + RELAY_TOKEN.`);
  }
  const host = cfg.hosts[name];
  if (!host) throw new Error(`Host "${name}" no existe en ${defaultCliConfigPath()}. Disponibles: ${Object.keys(cfg.hosts).join(", ") || "ninguno"}`);

  const token =
    host.token ??
    (host.tokenEnv ? process.env[host.tokenEnv] : undefined) ??
    (host.tokenFile ? readFileSync(host.tokenFile, "utf8").trim() : undefined);
  if (!token) {
    if (host.tokenEnv) {
      throw new Error(
        `El host "${name}" lee el token de la variable ${host.tokenEnv}, que no está definida en esta terminal. ` +
          `Ejecuta: export ${host.tokenEnv}='relay_…' (o agrégalo a tu ~/.zshrc / ~/.bashrc).`,
      );
    }
    throw new Error(`El host "${name}" no tiene token: define token, tokenEnv o tokenFile en ${defaultCliConfigPath()}`);
  }

  return {
    name,
    url: host.url,
    token,
    ca: host.ca ? readFileSync(host.ca) : undefined,
    cert: host.cert ? readFileSync(host.cert) : undefined,
    key: host.key ? readFileSync(host.key) : undefined,
    provider: host.provider,
  };
}
