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
 │  por el puente de herramientas (MCP → ACP)   ├─ traduce rutas local ⇄ espejo
 └──── WebSocket (token + TLS/mTLS opcional) ────┘   y lanza claude-agent-acp / codex-acp / opencode acp
                 sobre Tailscale/WireGuard
```

## Cómo llegan las herramientas del agente a tu máquina

Los agentes usan sus propias herramientas (`Read`, `Edit`, `Bash`…), que corren dentro de su proceso, en la máquina remota. Para que actúen sobre tu proyecto, el daemon incluye un **puente de herramientas MCP**:

1. En cada `session/new`, el daemon le pasa al agente un servidor MCP propio (`relay`) con las herramientas `read`, `write`, `edit`, `bash`, `grep` y `glob`, y desactiva las herramientas internas equivalentes según el `preset` del proveedor.
2. Cuando el agente usa una de ellas, el daemon **no la ejecuta**: la convierte en una petición ACP estándar (`fs/read_text_file`, `fs/write_text_file`, `terminal/*`) y la envía a tu CLI por el WebSocket existente.
3. Tu CLI la ejecuta en tu máquina, dentro de la carpeta del proyecto, y devuelve el resultado.

```
[remota]                                                   [tu máquina]
agente ──mcp: read("src/a.ts")──► daemon ──ACP: fs/read──► relay (CLI)
                                                              │ lee tu disco
agente ◄──────── contenido ─────── daemon ◄──── contenido ────┘
```

Las rutas se traducen en ambos sentidos, así que el agente sigue viendo su workspace espejo de forma coherente (por ejemplo, `pwd` le devuelve la ruta del espejo).

| Proveedor | Estado del puente |
|---|---|
| Claude Code (`claude-agent-acp`) | **Verificado** con el preset `claude-code`: lectura, escritura, comandos y búsquedas ocurren en tu máquina. |
| Codex (`codex-acp`) | El handshake funciona. Las herramientas del puente se ofrecen, pero aún no hay preset para desactivar el shell interno de Codex, así que puede seguir usándolo en la remota. |
| OpenCode (`opencode acp`) | **Verificado** con el preset `opencode` (OpenCode 1.19, usando un modelo de prueba): sus herramientas internas de archivos y shell se desactivan, solo quedan las del puente, y pide permiso antes de `write`, `edit` y `bash`. |

`grep` y `glob` se ejecutan en **la máquina del CLI** (tu computador), así que es ahí donde conviene instalar [ripgrep](https://github.com/BurntSushi/ripgrep): es más rápido y respeta `.gitignore`. Si no está, se usan `grep` y `find`. En la remota no hace falta. Con un cliente Windows, por ahora solo `read`, `write`, `edit` y `bash` (con `cmd.exe`).

## Requisitos

- Node.js 20 o superior en ambas máquinas.
- En la remota: el adaptador ACP de cada proveedor y su login hecho **allí** (`claude` → `/login`, `codex login`, `opencode auth login`).
- En tu máquina (recomendado): `ripgrep` (`brew install ripgrep`, `sudo apt install ripgrep` o `winget install BurntSushi.ripgrep.MSVC`).
- Recomendado: [Tailscale](https://tailscale.com) o [Headscale](https://github.com/juanfont/headscale) (100 % self-hosted) en ambas máquinas.

## Prueba real en 10 minutos

Puedes probarlo primero con el daemon y el CLI en **la misma máquina**, y después separarlos.

**1. Instala y compila** (en la máquina que hará de remota):

```bash
git clone https://github.com/invincibleOf/agent-relay && cd agent-relay
npm install && npm run build && npm link
```

**2. Prepara un proveedor en esa máquina.** Por ejemplo OpenCode: `npm i -g opencode-ai` y `opencode auth login` (o usa sus modelos gratuitos). Para Claude Code: instala `claude`, haz `/login` y el daemon usará `npx -y @agentclientprotocol/claude-agent-acp`.

**3. Configura y arranca el daemon:**

```bash
relay-daemon gen-token                      # copia el token y el hash
mkdir -p ~/.config/agent-relay
cp examples/daemon.yaml ~/.config/agent-relay/daemon.yaml
# Edita: listen.host = 127.0.0.1 para la prueba local, pega el hash en auth.tokenSha256
relay-daemon check && relay-daemon         # 'check' muestra el preset de cada proveedor
```

**4. En otra terminal, desde cualquier proyecto:**

```bash
cd ~/algun-proyecto
export RELAY_URL=ws://127.0.0.1:7443/acp RELAY_TOKEN='relay_…'
relay doctor -a opencode                    # o -a claude; debe decir "puente de herramientas: activo"
relay -a opencode
```

Pídele algo como *"lee el README, crea notas.txt con un resumen y ejecuta ls"*. Verás líneas `⌂ local lee/escribe/ejecuta` y el archivo aparecerá en tu proyecto.

**5. Separa las máquinas.** Instala Tailscale en ambas, cambia `listen.host` a la IP de Tailscale de la remota y `RELAY_URL` a `ws://<esa-ip>:7443/acp`. En la máquina local solo necesitas el CLI (pasos 1 y 4).

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

## Solución de problemas

**El agente dice que el proyecto está vacío o solo ve `.relay-manifest.json`.** Está usando sus herramientas internas sobre el workspace espejo en vez de las del puente. Corre `relay doctor` y revisa la línea `puente de herramientas`:

- `activo (preset claude-code)` u `activo (preset opencode)`: correcto. Las herramientas del agente deben aparecer como `mcp__relay__…` o `relay_…`.
- `desconocido`: el daemon es anterior a la v0.4. Actualiza y reinícialo: `git pull && npm install && npm run build`, luego detén y vuelve a iniciar `relay-daemon`.
- `activo, preset none` o `desactivado`: revisa `toolBridge` en `daemon.yaml`. Desde la v0.4, si lo omites, el preset se deduce del comando del agente (`preset: auto`).

**Aviso por `.claude`, `.codex` u `.opencode` en el proyecto.** No impide trabajar: el CLI solo sincroniza `AGENTS.md` y `.agents/`. Mueve a esos formatos lo que quieras que el agente use.

## Seguridad

- **Token**: 256 bits aleatorios; el daemon solo guarda el hash SHA-256.
- **Red**: el daemon debe escuchar solo en la interfaz de Tailscale/WireGuard o de la LAN. Sin TLS, el daemon lo advierte al arrancar.
- **TLS/mTLS**: opcional, TLS 1.3 mínimo; con `clientCa` se exige certificado de cliente.
- **Archivos locales**: el CLI solo permite leer, escribir y ejecutar dentro de la raíz del proyecto (y de `permissions.extraRoots`). Todo lo demás se rechaza.
- **Puente MCP**: escucha solo en `127.0.0.1` de la remota, con una URL secreta distinta por sesión que se invalida al cerrar la conexión.
- **Permisos**: con los presets `claude-code` y `opencode`, las herramientas de solo lectura (`read`, `grep`, `glob`) se aprueban solas; `write`, `edit` y `bash` siguen el flujo de permisos. Por defecto el CLI pregunta antes de cada acción que el agente marque como sensible; en modo `-p` sin `--yes`, se rechazan.
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
│   ├── tool-bridge.ts     # servidor MCP del puente: herramientas → ACP hacia el CLI
│   ├── presets.ts         # cómo desactivar las herramientas internas de cada agente
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

1. ~~Puente MCP de herramientas locales~~ (v0.2).
2. Preset para Codex que desactive su shell interno.
3. Reconexión y reanudación de sesiones (`session/load`).
4. Sincronización en vivo de `AGENTS.md` y `.agents/` cuando cambian durante la sesión.
5. Instalador como servicio (`systemd`/`launchd`) para el daemon.

## Licencia

MIT
