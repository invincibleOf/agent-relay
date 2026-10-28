# agent-relay

CLI local (`relay`) y daemon remoto (`relay-daemon`) en TypeScript que conectan agentes de código (Claude Code, Codex, OpenCode) vía Agent Client Protocol (ACP). El consumo de IA ocurre solo en el daemon; archivos y comandos se ejecutan en la máquina del CLI.

## Comandos

- Instalar: `npm install`
- Compilar: `npm run build`
- Tipos: `npm run typecheck`
- Pruebas: `npm test` (unitarias + e2e con `test/fake-agent.ts`)

## Estructura

- `src/shared/` — protocolo de control (`relay/hello`, `relay/ready`), traducción de rutas y utilidades de terminal (`ui.ts`).
- `src/daemon/` — servidor WebSocket, auth, workspace espejo, puente con el adaptador ACP y puente de herramientas MCP (`tool-bridge.ts`, `presets.ts`).
- `src/cli/` — REPL, cliente ACP, herramientas locales (fs/terminal), comandos, editor de entrada (`input.ts`), renderizado (`render.ts`, `markdown.ts`).
- `examples/` — configuraciones de ejemplo y un comando personalizado.

## Convenciones

- ESM (`"type": "module"`), imports relativos con extensión `.js`.
- Mensajes al usuario y comentarios en español.
- SDK de ACP: `@agentclientprotocol/sdk` (entrada estable v1). Usa las constantes de `methods`, no strings.
- Valida toda entrada externa con `zod` y toda ruta antes de tocar disco.
- Salida de terminal con `makeStyles` de `src/shared/ui.ts`: sin colores ni formato si no es una TTY o con `NO_COLOR`.

## Reglas del proyecto

- El CLI nunca debe incluir SDKs ni credenciales de proveedores de IA.
- No crear archivos específicos de un proveedor en proyectos de usuario (`CLAUDE.md`, `.claude/`, `.codex/`, `.opencode/`); solo `AGENTS.md` y `.agents/`. La traducción a cada proveedor vive en el daemon (`src/daemon/workspace.ts`, `src/daemon/presets.ts`).
- Todo cambio de comportamiento debe cubrirse en `test/e2e.test.ts` o `test/unit.test.ts`.
