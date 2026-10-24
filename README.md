# agent-relay

CLI local para usar agentes de código —**Claude Code**, **Codex** u **OpenCode**— que se ejecutan en **otra máquina** (AWS, un servidor en tu casa…), mientras el trabajo ocurre sobre **tu** proyecto.

- **Todo el consumo de IA sale del daemon remoto.** El CLI no tiene SDKs ni credenciales de proveedores; su única salida de red es el WebSocket hacia tu daemon.
- **Formatos abiertos, sin atarte a un proveedor.** Tu proyecto solo usa [`AGENTS.md`](https://agents.md) y [Agent Skills](https://agentskills.io) en `.agents/`. Los archivos propios de cada proveedor (`CLAUDE.md`, `.claude/skills`…) se generan solo en el daemon.
- **La remota puede estar donde quieras.** Pensado para Tailscale/WireGuard: misma configuración en tu LAN o en AWS, sin abrir puertos.
- Basado en el [Agent Client Protocol (ACP)](https://agentclientprotocol.com).

```
[tu máquina]                                  [remota: AWS o tu casa]
relay (CLI)                                     relay-daemon
 ├─ sin credenciales de IA                       ├─ único dueño de credenciales
 ├─ AGENTS.md + .agents/ (formato abierto)  ──►  ├─ workspace espejo por proyecto y proveedor
 ├─ lee/escribe archivos y ejecuta comandos      │   (AGENTS.md, skills, CLAUDE.md, .claude/skills…)
 │  cuando el agente lo delega (ACP)             ├─ traduce rutas local ⇄ espejo
 └──── WebSocket (token + TLS/mTLS opcional) ────┘   y lanza claude-agent-acp / codex-acp / opencode acp
                 sobre Tailscale/WireGuard
```

> ### ⚠️ Estado actual (v0.1): qué corre dónde
>
> El protocolo y el daemon funcionan de punta a punta, y todo lo que el agente **delega por ACP** (`fs/read_text_file`, `fs/write_text_file`, `terminal/*`) ocurre en tu máquina. Lo verifica la prueba `test/e2e.test.ts`.
>
> Pero en una prueba real con `@agentclientprotocol/claude-agent-acp` 0.95.0, **Claude Code no delegó ninguna herramienta**: `Read`, `Bash` y `Grep` se ejecutaron sobre el workspace espejo remoto, que solo contiene `AGENTS.md` y las skills. El adaptador implementa los métodos de ACP, pero no conecta las herramientas internas de Claude Code a ellos. Con Codex y OpenCode el comportamiento no está verificado aún.
>
> La siguiente versión resuelve esto sin depender de cada adaptador (ver [Hoja de ruta](#hoja-de-ruta)).

## Requisitos

- Node.js 20 o superior en ambas máquinas.
- En la remota: el adaptador ACP de cada proveedor y su login hecho **allí** (`claude` → `/login`, `codex login`, `opencode auth login`).
- Recomendado: [Tailscale](https://tailscale.com) o [Headscale](https://github.com/juanfont/headscale) (100 % self-hosted) en ambas máquinas.

## Instalación

```bash
git clone <este-repo> agent-relay && cd agent-relay
npm install
npm run build
npm link            # deja disponibles `relay` y `relay-daemon`
```

## Configuración

### 1. Daemon (máquina remota)

```bash
relay-daemon gen-token
# Token (guárdalo en la config del CLI, no se vuelve a mostrar):
#   relay_…
# Hash para daemon.yaml → auth.tokenSha256:
#   - "…"

mkdir -p ~/.config/agent-relay
cp examples/daemon.yaml ~/.config/agent-relay/daemon.yaml
# Edita: listen.host = IP de Tailscale de esta máquina, pega el hash del token.

relay-daemon check     # valida la configuración
relay-daemon           # inicia el daemon
```

El daemon guarda el token solo como hash SHA-256 y lo compara en tiempo constante. Para sumar TLS 1.3 o mTLS, descomenta la sección `tls` (con `clientCa`, exige certificado de cliente).

### 2. CLI (tu máquina)

```bash
mkdir -p ~/.config/agent-relay
cp examples/cli.yaml ~/.config/agent-relay/cli.yaml
export RELAY_TOKEN_CASA='relay_…'

relay doctor           # verifica conexión, agente y workspace espejo
```

Para una prueba rápida sin archivo de configuración:

```bash
RELAY_URL=ws://servidor-casa:7443/acp RELAY_TOKEN='relay_…' relay doctor
```

## Uso

```bash
relay                              # sesión interactiva con el proveedor por defecto
relay -a codex                     # elige proveedor
relay -H aws                       # elige host
relay -p "explica src/main.ts"     # un solo prompt y salir
relay -y                           # aprueba permisos automáticamente (con cuidado)
```

Comandos dentro de la sesión (estilo OpenCode):

| Comando | Qué hace |
|---|---|
| `/help` | Ayuda |
| `/new` | Nueva sesión con el agente |
| `/init` | Crea o mejora `AGENTS.md` (sin crear archivos de proveedor) |
| `/commands` | Lista comandos personalizados y los que anuncia el agente |
| `/modes`, `/mode <id>` | Lista o cambia el modo del agente |
| `/status` | Host, proveedor, daemon, workspace espejo y sesión |
| `/exit` | Salir |
| `@ruta/archivo` | Adjunta un archivo local como referencia |
| `Ctrl+C` | Cancela el turno (dos veces seguidas para salir) |

Cualquier otro `/comando` se busca en tus comandos personalizados; si no existe, se envía al agente (por ejemplo, los comandos propios de Claude Code).

## Formatos abiertos en tu proyecto

```
mi-proyecto/
├── AGENTS.md                      # instrucciones del proyecto (agents.md)
└── .agents/
    ├── skills/<nombre>/SKILL.md   # Agent Skills (agentskills.io)
    └── commands/<nombre>.md       # comandos personalizados
```

- Al conectarse, el CLI envía todos los `AGENTS.md` y el contenido de `.agents/` (máx. 1 MiB por archivo, 8 MiB en total).
- El daemon los escribe en el workspace espejo y los traduce al formato de cada proveedor según `skillsDirs` e `instructionAliases` (por ejemplo, `.claude/skills → .agents/skills` y `CLAUDE.md` con `@AGENTS.md`).
- Si el CLI encuentra `CLAUDE.md`, `.claude/`, `.codex/` u `.opencode/` en tu proyecto, te avisa para que migres ese contenido al formato abierto.

### Comandos personalizados

`.agents/commands/<nombre>.md` (del proyecto) o `~/.config/agent-relay/commands/<nombre>.md` (globales). Frontmatter opcional con `description`; el cuerpo es la plantilla del prompt, con `$ARGUMENTS` (todo el texto) y `$1…$9` (por palabra). El CLI los expande localmente, así que funcionan igual con cualquier proveedor. Hay un ejemplo en [`examples/commands/revisar.md`](examples/commands/revisar.md).

## Seguridad

- **Token**: 256 bits aleatorios; el daemon solo guarda el hash SHA-256.
- **Red**: el daemon debe escuchar solo en la interfaz de Tailscale/WireGuard o de la LAN. Sin TLS, el daemon lo advierte al arrancar.
- **TLS/mTLS**: opcional, TLS 1.3 mínimo; con `clientCa` se exige certificado de cliente.
- **Archivos locales**: el CLI solo permite leer, escribir y ejecutar dentro de la raíz del proyecto (y de `permissions.extraRoots`). Todo lo demás se rechaza.
- **Permisos**: por defecto el CLI pregunta antes de cada acción que el agente marque como sensible; en modo `-p` sin `--yes`, se rechazan.
- **Workspace espejo**: las rutas que llegan del CLI se validan (nada absoluto ni con `..`) antes de escribirse en el daemon.

## Desarrollo

```bash
npm run typecheck
npm test                 # pruebas unitarias + e2e con un agente ACP falso
npm run dev:daemon -- --config examples/daemon.yaml
npm run dev:cli -- doctor
```

Estructura:

```
src/
├── shared/protocol.ts     # handshake relay/hello ⇄ relay/ready y traducción de rutas
├── daemon/
│   ├── main.ts            # servidor WebSocket, auth, TLS/mTLS
│   ├── session.ts         # puente WebSocket ⇄ stdio del adaptador ACP
│   ├── workspace.ts       # workspace espejo y traducción a formatos de proveedor
│   ├── auth.ts, config.ts
└── cli/
    ├── main.ts            # REPL, comandos, permisos
    ├── transport.ts       # conexión con el daemon → Stream ACP
    ├── local-tools.ts     # fs y terminales en tu máquina
    ├── project.ts         # raíz del proyecto y archivos en formato abierto
    ├── commands.ts        # comandos personalizados y /init
    ├── render.ts, config.ts
test/
├── fake-agent.ts          # agente ACP de prueba
├── e2e.test.ts            # daemon + CLI + agente falso de punta a punta
└── unit.test.ts
```

## Hoja de ruta

1. **Puente MCP de herramientas locales (siguiente).** El daemon expone un servidor MCP por sesión (`read`, `write`, `edit`, `bash`, `grep`, `glob`) cuyas herramientas se implementan enviando peticiones ACP estándar (`fs/*`, `terminal/*`) al CLI por la conexión existente. Se pasa al agente en `session/new → mcpServers` y se desactivan sus herramientas internas por proveedor (Claude Code: `_meta.claudeCode.options.disallowedTools`; OpenCode: `tools` en su configuración; Codex: por investigar). Así todo ocurre en tu máquina, sin depender de cada adaptador.
2. Reconexión y reanudación de sesiones (`session/load`).
3. Sincronización en vivo de `AGENTS.md` y `.agents/` cuando cambian durante la sesión.
4. Instalador como servicio (`systemd`/`launchd`) para el daemon.

## Licencia

MIT
