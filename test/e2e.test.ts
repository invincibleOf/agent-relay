import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectId as projectIdFor } from "../src/cli/project.ts";
import { generateToken } from "../src/daemon/auth.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href;
const port = 17000 + Math.floor(Math.random() * 2000);

let base: string;
let project: string;
let workspaces: string;
let daemon: ChildProcess;
const { token, sha256 } = generateToken();

function runCli(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsxLoader, path.join(repo, "src/cli/main.ts"), ...args], {
      cwd: project,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), RELAY_TOKEN: token, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("relay de punta a punta con un agente falso", () => {
  before(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "relay-e2e-")));
    project = path.join(base, "mi-proyecto");
    workspaces = path.join(base, "remote-workspaces");
    mkdirSync(path.join(project, ".git"), { recursive: true });
    mkdirSync(path.join(project, ".agents", "skills", "demo"), { recursive: true });
    mkdirSync(path.join(project, ".agents", "commands"), { recursive: true });
    writeFileSync(path.join(project, "AGENTS.md"), "# Proyecto de prueba\n");
    writeFileSync(path.join(project, "README.md"), "hola desde el disco local\n");
    writeFileSync(path.join(project, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: skill de prueba\n---\nHaz algo.\n");

    const cfg = path.join(base, "daemon.yaml");
    writeFileSync(
      cfg,
      [
        `listen: { host: 127.0.0.1, port: ${port} }`,
        `auth: { tokenSha256: ["${sha256}"] }`,
        `workspacesDir: ${JSON.stringify(workspaces)}`,
        "defaultProvider: fake",
        "providers:",
        "  fake:",
        `    command: ${JSON.stringify(process.execPath)}`,
        `    args: ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(path.join(repo, "test/fake-agent.ts"))}]`,
        "    env: { FAKE_PROVIDER_KEY: secreto }",
        '    skillsDirs: [".claude/skills"]',
        "    instructionAliases: [{ path: CLAUDE.md }]",
        "    toolBridge: { preset: claude-code }",
        "  fake-sin-puente:",
        `    command: ${JSON.stringify(process.execPath)}`,
        `    args: ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(path.join(repo, "test/fake-agent.ts"))}]`,
        "    toolBridge: { enabled: false }",
      ].join("\n"),
    );

    daemon = spawn(process.execPath, ["--import", tsxLoader, path.join(repo, "src/daemon/main.ts"), "--config", cfg]);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("el daemon no arrancó")), 15000);
      daemon.stderr!.on("data", (d: Buffer) => {
        if (process.env.RELAY_TEST_DEBUG) process.stderr.write(d);
        if (d.toString().includes("escuchando")) {
          clearTimeout(t);
          resolve();
        }
      });
    });
  });

  after(() => {
    daemon?.kill();
    if (!process.env.RELAY_KEEP) rmSync(base, { recursive: true, force: true });
    else console.error("BASE", base);
  });

  test("el agente piensa en remoto y actúa sobre el disco local", async () => {
    const r = await runCli(["--url", `ws://127.0.0.1:${port}/acp`, "-p", "hola @README.md", "--yes"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);

    const mirror = path.join(workspaces, projectIdFor(project), "fake");
    const remoteReport = readFileSync(path.join(mirror, ".fake-report"), "utf8");
    const remote = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(remoteReport)?.[1];
    const get = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(r.stdout)?.[1];

    // En remoto, el agente nunca ve la ruta local: trabaja en el workspace espejo.
    assert.equal(remote("CWD_AGENTE"), mirror);
    assert.equal(remote("PROCESS_CWD"), mirror);
    // En local, el usuario ve sus propias rutas: el daemon las traduce de vuelta.
    assert.equal(get("CWD_AGENTE"), project);
    // Archivos abiertos sincronizados y traducidos al formato del proveedor, solo en remoto.
    assert.equal(get("AGENTS_REMOTO"), "si");
    assert.equal(get("ALIAS_CLAUDE"), "@AGENTS.md");
    assert.equal(get("SKILLS_ENLAZADAS"), "si");
    // La credencial solo existe en el daemon.
    assert.equal(get("CREDENCIAL"), "presente");
    // Lectura, escritura y comandos ocurrieron en la máquina local.
    assert.equal(get("README"), "hola desde el disco local");
    assert.equal(get("PERMISO"), "si");
    assert.equal(readFileSync(path.join(project, "salida.txt"), "utf8"), "escrito por el agente remoto\n");
    assert.equal(get("PWD_TERMINAL"), project);
    assert.equal(get("FUERA_DEL_PROYECTO"), "denegado");
    // El @archivo llegó al agente como ruta del workspace espejo.
    assert.equal(remote("PROMPT"), `hola @README.md [resource_link:file://${mirror}/README.md]`);

    // Nada específico de un proveedor terminó en el proyecto local.
    for (const f of ["CLAUDE.md", ".claude", ".codex", ".opencode"]) assert.equal(existsSync(path.join(project, f)), false, f);
    // Y la escritura no quedó en el espejo remoto.
    assert.equal(existsSync(path.join(mirror, "salida.txt")), false);
    // El CLI mostró la actividad local.
    assert.match(r.stdout, /⌂ escribe\s+salida\.txt/);
    assert.match(r.stdout, /⌂ ejecuta\s+\$ pwd/);
  });

  test("sin --yes en modo no interactivo, los permisos se rechazan", async () => {
    rmSync(path.join(project, "salida.txt"), { force: true });
    const r = await runCli(["--url", `ws://127.0.0.1:${port}/acp`, "-p", "hola"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^PERMISO=no$/m);
    assert.equal(existsSync(path.join(project, "salida.txt")), false);
  });

  test("un token inválido es rechazado", async () => {
    const r = await runCli(["--url", `ws://127.0.0.1:${port}/acp`, "-p", "hola"], { RELAY_TOKEN: "relay_malo" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /401/);
  });

  test("un proveedor inexistente se informa con los disponibles", async () => {
    const r = await runCli(["--url", `ws://127.0.0.1:${port}/acp`, "-a", "otro", "-p", "hola"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /proveedor "otro" no configurado.*fake/);
  });

  test("puente MCP: las herramientas del agente se ejecutan en la máquina local", async () => {
    const r = await runCli(["--url", `ws://127.0.0.1:${port}/acp`, "-p", "PUENTE", "--yes"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);

    const mirror = path.join(workspaces, projectIdFor(project), "fake");
    const report = readFileSync(path.join(mirror, ".fake-report"), "utf8");
    const get = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(report)?.[1];

    // El daemon inyectó el servidor MCP local y el preset de Claude Code.
    assert.equal(get("MCP_URL"), "127.0.0.1");
    assert.equal(get("DISALLOWED_READ"), "si");
    assert.equal(get("ALLOWED"), "mcp__relay__read,mcp__relay__grep,mcp__relay__glob");
    assert.equal(get("TOOLS"), "bash,edit,glob,grep,read,write");

    // Lecturas: relativas y absolutas del espejo llegan a tu disco.
    assert.equal(JSON.parse(get("B_READ")!), "     1\thola desde el disco local");
    assert.equal(JSON.parse(get("B_READ_ABS")!), "     1\thola desde el disco local");
    assert.equal(JSON.parse(get("B_READ_ALIAS")!), "     1\thola desde el disco local");
    assert.equal(get("B_READ_SIN_RUTA"), "error");

    // Escritura y edición sobre el proyecto local; el edit ambiguo se rechaza.
    assert.equal(get("B_WRITE"), "ok");
    assert.equal(get("B_EDIT_AMBIGUO"), "error");
    assert.equal(get("B_EDIT"), "ok");
    assert.equal(readFileSync(path.join(project, "src/nuevo.ts"), "utf8"), "export const a = 1;\nexport const b = 2;\n");
    assert.equal(existsSync(path.join(mirror, "src/nuevo.ts")), false);

    // bash corre en la raíz local, pero el agente ve rutas del espejo (coherencia).
    assert.equal(get("B_PWD"), mirror);
    assert.equal(readFileSync(path.join(project, "marca.txt"), "utf8"), "hecho\n");
    assert.match(JSON.parse(get("B_EXIT")!), /código de salida 3/);

    // grep y glob buscan en el proyecto local y devuelven rutas del espejo.
    assert.equal(JSON.parse(get("B_GREP")!), `${mirror}/src/nuevo.ts:2:export const b = 2;`);
    assert.match(JSON.parse(get("B_GLOB")!), new RegExp(`${mirror}/src/nuevo\\.ts`));

    // Fuera del proyecto: denegado por el CLI.
    assert.equal(get("B_FUERA"), "denegado");
    assert.match(r.stdout, /⌂ escribe\s+src\/nuevo\.ts/);
    assert.match(r.stdout, /⌂ edita\s+src\/nuevo\.ts/);
    assert.doesNotMatch(r.stdout, /⌂ lee\s+src\/nuevo\.ts/); // la lectura interna del edit no se muestra
    assert.match(r.stdout, /⌂ busca\s+'const b' \(\*\.ts\)/);
    assert.match(r.stdout, /⌂ lista\s+\*\*\/\*\.ts/);
  });

  test("con el puente desactivado no se inyecta nada", async () => {
    const r = await runCli(["--url", `ws://127.0.0.1:${port}/acp`, "-a", "fake-sin-puente", "-p", "PUENTE", "--yes"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^MCP_URL=no$/m);
    assert.match(r.stderr, /el puente está desactivado/);
    assert.match(r.stdout, /^DISALLOWED_READ=no$/m);
  });

  test("-C continúa la última sesión, sessions las lista y --resume elige una", async () => {
    const url = ["--url", `ws://127.0.0.1:${port}/acp`];
    let r = await runCli([...url, "-p", "ECO uno"]);
    assert.match(r.stdout, /eco: uno \(historial: 1\)/, r.stderr);

    r = await runCli([...url, "-C", "-p", "ECO dos"]);
    assert.match(r.stdout, /eco: dos \(historial: 2\)/, r.stderr);
    assert.match(r.stderr, /sesión reanudada · Sesión de uno/);

    r = await runCli([...url, "-p", "ECO otra"]); // una sesión nueva
    assert.match(r.stdout, /eco: otra \(historial: 1\)/);

    r = await runCli([...url, "sessions"]);
    assert.equal(r.code, 0, r.stderr);
    const rowUno = r.stdout.split("\n").find((l) => l.includes("Sesión de uno"));
    const rowOtra = r.stdout.split("\n").find((l) => l.includes("Sesión de otra"));
    assert.ok(rowUno && rowOtra, r.stdout);
    assert.ok(r.stdout.indexOf("Sesión de otra") < r.stdout.indexOf("Sesión de uno"), "la más reciente primero");

    // Por prefijo de id (como lo muestra la lista) y por número.
    const idUno = /\b(ses-\w{4})/.exec(rowUno!)![1];
    r = await runCli([...url, "--resume", idUno, "-p", "ECO tres"]);
    assert.match(r.stdout, /eco: tres \(historial: 3\)/, r.stderr);
    r = await runCli([...url, "--resume", "1", "-p", "ECO cuatro"]); // ahora la más reciente es "uno"
    assert.match(r.stdout, /eco: cuatro \(historial: 4\)/, r.stderr);

    r = await runCli([...url, "--resume", "no-existe", "-p", "ECO x"]);
    assert.equal(r.code, 1);
  });

  test("si se cae la conexión, el CLI se reconecta y sigue en la misma sesión", async () => {
    const child = spawn(process.execPath, ["--import", tsxLoader, path.join(repo, "src/cli/main.ts"), "--url", `ws://127.0.0.1:${port}/acp`], {
      cwd: project,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), RELAY_TOKEN: token },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const waitFor = (re: RegExp, ms = 30_000) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => (re.test(out) ? resolve() : Date.now() - t0 > ms ? reject(new Error(`no apareció ${re}:\n${out}`)) : setTimeout(tick, 50));
        tick();
      });
    try {
      await waitFor(/› $/m);
      child.stdin.write("ECO r1\n");
      await waitFor(/eco: r1 \(historial: 1\)/);
      child.stdin.write("MUERE\n"); // el proceso del agente termina a mitad del turno
      await waitFor(/se perdió la conexión con el daemon/);
      await waitFor(/✓ reconectado · sesión restaurada/);
      child.stdin.write("ECO r2\n");
      await waitFor(/eco: r2 \(historial: 2\)/);
      child.stdin.write("/status\n");
      await waitFor(/sesión\s+Sesión de r1/);
      child.stdin.write("/exit\n");
      const code = await new Promise((r) => child.on("close", r));
      assert.equal(code, 0, out);
    } finally {
      child.kill();
    }
  });

  test("doctor muestra el agente y el workspace espejo", async () => {
    const r = await runCli(["doctor", "--url", `ws://127.0.0.1:${port}/acp`]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /agente\s+fake-agent 0\.0\.1/);
    assert.match(r.stdout, /✓ puente\s+activo \(preset claude-code\)/);
    assert.match(r.stdout, /ripgrep\s+ripgrep \d/);
    assert.doesNotMatch(r.stdout, /^\s+! /m);
    assert.match(r.stdout, /espejo\s+\S+/);
  });
});
