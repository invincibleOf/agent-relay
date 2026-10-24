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
    rmSync(base, { recursive: true, force: true });
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
    assert.match(r.stdout, /local escribe: salida\.txt/);
    assert.match(r.stdout, /local ejecuta: pwd/);
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

  test("doctor muestra el agente y el workspace espejo", async () => {
    const r = await runCli(["doctor", "--url", `ws://127.0.0.1:${port}/acp`]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /agente: fake-agent 0\.0\.1/);
    assert.match(r.stdout, /workspace espejo: /);
  });
});
