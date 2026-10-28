import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const expandHome = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);

const Host = z.object({
  /** ws://… o wss://…, normalmente la IP/nombre de Tailscale del daemon, terminando en /acp. */
  url: z.string().regex(/^wss?:\/\//, "debe empezar con ws:// o wss:// y terminar en /acp, p. ej. ws://100.x.y.z:7443/acp"),
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

/** Información sobre de dónde salió la configuración, para dar errores útiles. */
export interface ConfigSource {
  path: string;
  exists: boolean;
  /** Claves de primer nivel que no se reconocen (p. ej. "host" en vez de "hosts"). */
  unknownKeys: string[];
  /** Archivos parecidos en la misma carpeta (p. ej. cli.yaml.txt de TextEdit). */
  similarFiles: string[];
}
export type LoadedCliConfig = CliConfig & { source: ConfigSource };

const KNOWN_KEYS = new Set(["defaultHost", "hosts", "permissions"]);

export function loadCliConfig(file: string): LoadedCliConfig {
  const exists = existsSync(file);
  let similarFiles: string[] = [];
  try {
    const base = path.basename(file, path.extname(file));
    similarFiles = readdirSync(path.dirname(file)).filter(
      (f) => f !== path.basename(file) && f.toLowerCase().startsWith(base.toLowerCase()),
    );
  } catch {
    /* la carpeta no existe */
  }
  if (!exists) return { ...CliConfig.parse({}), source: { path: file, exists, unknownKeys: [], similarFiles } };

  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch (err) {
    throw new Error(`${file} no es YAML válido: ${(err as Error).message.split("\n")[0]} (usa espacios, no tabs, para indentar)`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} debe ser un objeto YAML con las claves defaultHost, hosts y permissions`);
  }
  const unknownKeys = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
  const parsed = CliConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
    throw new Error(`${file} tiene errores: ${issues}`);
  }
  return { ...parsed.data, source: { path: file, exists, unknownKeys, similarFiles } };
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
export function resolveHost(cfg: LoadedCliConfig, hostName?: string, urlOverride?: string): ResolvedHost {
  const url = urlOverride ?? process.env.RELAY_URL;
  if (url) {
    const token = process.env.RELAY_TOKEN;
    if (!token) throw new Error("Con --url o RELAY_URL debes definir RELAY_TOKEN");
    return { name: "url", url, token };
  }

  const name = hostName ?? cfg.defaultHost ?? Object.keys(cfg.hosts)[0];
  if (!name) throw new Error(noHostsMessage(cfg.source));
  const host = cfg.hosts[name];
  if (!host) {
    if (Object.keys(cfg.hosts).length === 0) throw new Error(noHostsMessage(cfg.source));
    throw new Error(`Host "${name}" no existe en ${cfg.source.path}. Disponibles: ${Object.keys(cfg.hosts).join(", ")}`);
  }

  const token =
    host.token ??
    (host.tokenEnv ? process.env[host.tokenEnv] : undefined) ??
    (host.tokenFile ? readFileSync(host.tokenFile, "utf8").trim() : undefined);
  if (!token) {
    if (host.tokenEnv) {
      throw new Error(
        `El host "${name}" lee el token de la variable ${host.tokenEnv}, que no está definida en esta terminal. ` +
          (process.platform === "win32"
            ? `En PowerShell: $env:${host.tokenEnv}='relay_…' (o, para que persista: setx ${host.tokenEnv} "relay_…" y abre una terminal nueva).`
            : `Ejecuta: export ${host.tokenEnv}='relay_…' (o agrégalo a tu ~/.zshrc / ~/.bashrc).`),
      );
    }
    throw new Error(`El host "${name}" no tiene token: define token, tokenEnv o tokenFile en ${cfg.source.path}`);
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

function noHostsMessage(src: ConfigSource): string {
  const fallback = "o usa RELAY_URL + RELAY_TOKEN sin archivo de configuración.";
  if (!src.exists) {
    const similar = src.similarFiles.length
      ? ` Encontré ${src.similarFiles.map((f) => `"${f}"`).join(", ")} en esa carpeta: renómbralo a "${path.basename(src.path)}".`
      : "";
    return `No existe ${src.path}.${similar} Crea el archivo (ver examples/cli.yaml) ${fallback}`;
  }
  const keys = src.unknownKeys.length ? ` Claves no reconocidas: ${src.unknownKeys.join(", ")} (¿quisiste decir "hosts"?).` : "";
  return `${src.path} existe pero no define ningún host bajo "hosts:".${keys} Revisa que cada host esté indentado con espacios debajo de "hosts:", ${fallback}`;
}
