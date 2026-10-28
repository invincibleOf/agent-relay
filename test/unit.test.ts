import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTemplate } from "../src/cli/commands.ts";
import { displayCommand } from "../src/cli/local-tools.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deepMerge, presetSessionMeta, presetSpawnEnv } from "../src/daemon/presets.ts";
import { detectPreset } from "../src/daemon/config.ts";
import { buildGlobCommand, buildGrepCommand } from "../src/daemon/tool-bridge.ts";
import { windowsCommandLine } from "../src/daemon/session.ts";
import { safeRelativePath } from "../src/daemon/workspace.ts";
import { rewritePathPrefix } from "../src/shared/protocol.ts";

test("rewritePathPrefix traduce rutas en objetos anidados", () => {
  const msg = { params: { cwd: "/home/carlos/app", path: "/home/carlos/app/src/a.ts", list: ["/home/carlos/app"] } };
  const out = rewritePathPrefix(msg, "/home/carlos/app", "/srv/ws/abc", "/", "/");
  assert.deepEqual(out, { params: { cwd: "/srv/ws/abc", path: "/srv/ws/abc/src/a.ts", list: ["/srv/ws/abc"] } });
});

test("rewritePathPrefix no toca rutas hermanas ni texto sin frontera", () => {
  const out = rewritePathPrefix({ a: "/home/carlos/app-viejo/x", b: "x/home/carlos/app" }, "/home/carlos/app", "/srv", "/", "/");
  assert.deepEqual(out, { a: "/home/carlos/app-viejo/x", b: "x/home/carlos/app" });
});

test("rewritePathPrefix traduce rutas dentro de texto y URIs file://", () => {
  const out = rewritePathPrefix("Edité /home/c/app/a.ts y file:///home/c/app/b.ts", "/home/c/app", "/srv/w", "/", "/");
  assert.equal(out, "Edité /srv/w/a.ts y file:///srv/w/b.ts");
});

test("rewritePathPrefix convierte separadores de Windows", () => {
  const out = rewritePathPrefix({ p: "C:\\Users\\c\\app\\src\\x.ts" }, "C:\\Users\\c\\app", "/srv/w", "\\", "/");
  assert.deepEqual(out, { p: "/srv/w/src/x.ts" });
  const back = rewritePathPrefix({ p: "/srv/w/src/x.ts" }, "/srv/w", "C:\\Users\\c\\app", "/", "\\");
  assert.deepEqual(back, { p: "C:\\Users\\c\\app\\src\\x.ts" });
});

test("safeRelativePath bloquea rutas fuera del workspace", () => {
  assert.throws(() => safeRelativePath("../etc/passwd", "/srv/w"));
  assert.throws(() => safeRelativePath("/etc/passwd", "/srv/w"));
  assert.throws(() => safeRelativePath("a/../../x", "/srv/w"));
  assert.equal(safeRelativePath(".agents/skills/x/SKILL.md", "/srv/w"), "/srv/w/.agents/skills/x/SKILL.md");
});

test("deepMerge mezcla _meta del cliente con el preset", () => {
  const merged = deepMerge(
    { claudeCode: { options: { disallowedTools: ["X"], model: "m" } }, otro: 1 },
    presetSessionMeta("claude-code"),
  ) as { claudeCode: { options: { disallowedTools: string[]; model: string } }; otro: number; systemPrompt: { append: string } };
  assert.equal(merged.otro, 1);
  assert.equal(merged.claudeCode.options.model, "m");
  assert.ok(merged.claudeCode.options.disallowedTools.includes("X"));
  assert.ok(merged.claudeCode.options.disallowedTools.includes("Bash"));
  assert.match(merged.systemPrompt.append, /relay/);
  assert.deepEqual(presetSessionMeta("none"), {});
});

test("presetSpawnEnv de OpenCode desactiva herramientas internas y conserva la config del usuario", () => {
  const root = mkdtempSync(path.join(tmpdir(), "relay-preset-"));
  try {
    const env = presetSpawnEnv("opencode", root, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "x/y", tools: { webfetch: false } }) });
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(cfg.model, "x/y");
    assert.equal(cfg.tools.webfetch, false);
    for (const t of ["bash", "read", "write", "edit", "grep", "glob"]) assert.equal(cfg.tools[t], false, t);
    assert.equal(cfg.permission.relay_bash, "ask");
    assert.equal(cfg.permission.relay_write, "ask");
    assert.equal(cfg.permission.relay_read, undefined);
    assert.match(readFileSync(cfg.instructions[0], "utf8"), /relay/);
    assert.deepEqual(presetSpawnEnv("claude-code", root, {}), {});
    assert.throws(() => presetSpawnEnv("opencode", root, { OPENCODE_CONFIG_CONTENT: "{no-json" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectPreset deduce el preset desde el comando del agente", () => {
  assert.equal(detectPreset("npx", ["-y", "@agentclientprotocol/claude-agent-acp"]), "claude-code");
  assert.equal(detectPreset("/usr/local/bin/claude-agent-acp", []), "claude-code");
  assert.equal(detectPreset("opencode", ["acp"]), "opencode");
  assert.equal(detectPreset("/opt/homebrew/bin/opencode", ["acp"]), "opencode");
  assert.equal(detectPreset("npx", ["-y", "opencode-ai@latest", "acp"]), "opencode");
  assert.equal(detectPreset("npx", ["-y", "@zed-industries/codex-acp"]), "none");
  assert.equal(detectPreset("node", ["fake-agent.ts"]), "none");
});

test("displayCommand muestra el comando sin el envoltorio del shell", () => {
  assert.equal(displayCommand("/bin/sh", ["-c", "ls -a"]), "ls -a");
  assert.equal(displayCommand("cmd.exe", ["/d", "/s", "/c", "dir"]), "dir");
  assert.equal(displayCommand("pwd", []), "pwd");
  assert.equal(displayCommand("git", ["status", "-s"]), "git status -s");
});

test("expandTemplate sustituye $ARGUMENTS y posicionales", () => {
  assert.equal(expandTemplate("Revisa $1 con foco en $2. Todo: $ARGUMENTS", "src/a.ts seguridad"), "Revisa src/a.ts con foco en seguridad. Todo: src/a.ts seguridad");
});

test("grep y glob del puente generan comandos POSIX y PowerShell", () => {
  const posix = buildGrepCommand({ pattern: "it's", path: "/p", glob: "*.ts", max: 10 }, false);
  assert.match(posix, /^if command -v rg/);
  assert.ok(posix.includes(`-e 'it'\\''s' -- '/p'`));
  assert.ok(posix.endsWith("| head -n 10"));

  const ps = buildGrepCommand({ pattern: "it's", path: "C:\\p", glob: "*.java", ignoreCase: true, max: 5 }, true);
  assert.match(ps, /^& \{ if \(Get-Command rg/);
  assert.ok(ps.includes(`-e 'it''s' 'C:\\p'`), "comillas de PowerShell y sin --");
  assert.ok(!ps.includes(" -- "));
  assert.ok(ps.includes("Select-String -Pattern 'it''s'") && !ps.includes("-CaseSensitive"));
  assert.ok(ps.endsWith("Select-Object -First 5"));
  assert.ok(!ps.includes('"'), "sin comillas dobles: evita problemas de escape en Windows");
  assert.ok(buildGrepCommand({ pattern: "x", path: "C:\\p", max: 1 }, true).includes("-CaseSensitive"));

  const files = buildGrepCommand({ pattern: "x", path: "C:\\p", filesOnly: true, max: 1 }, true);
  assert.ok(files.includes("rg -l") && files.includes("-List") && files.includes("$_.Path }"));

  const gps = buildGlobCommand({ pattern: "src/**/*.java", path: "C:\\p", max: 7 }, true);
  assert.ok(gps.includes("-g 'src/**/*.java' 'C:\\p'") && gps.includes("-Filter '*.java'") && gps.endsWith("-First 7"));
  assert.match(buildGlobCommand({ pattern: "**/*.ts", path: "/p", max: 3 }, false), /find '\/p' -type f -name '\*\.ts'/);
});

test("displayCommand reconoce PowerShell", () => {
  assert.equal(displayCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"]), "Get-ChildItem");
});

test("windowsCommandLine pone comillas solo donde hace falta", () => {
  assert.equal(windowsCommandLine("npx", ["-y", "@zed-industries/codex-acp"]), "npx -y @zed-industries/codex-acp");
  assert.equal(
    windowsCommandLine("C:\\Program Files\\nodejs\\npx.cmd", ["-y", "a b", 'x"y']),
    '"C:\\Program Files\\nodejs\\npx.cmd" -y "a b" "x""y"',
  );
});
