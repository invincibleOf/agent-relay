import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTemplate } from "../src/cli/commands.ts";
import { displayCommand } from "../src/cli/local-tools.ts";
import { deepMerge, presetSessionMeta } from "../src/daemon/presets.ts";
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

test("displayCommand muestra el comando sin el envoltorio del shell", () => {
  assert.equal(displayCommand("/bin/sh", ["-c", "ls -a"]), "ls -a");
  assert.equal(displayCommand("cmd.exe", ["/d", "/s", "/c", "dir"]), "dir");
  assert.equal(displayCommand("pwd", []), "pwd");
  assert.equal(displayCommand("git", ["status", "-s"]), "git status -s");
});

test("expandTemplate sustituye $ARGUMENTS y posicionales", () => {
  assert.equal(expandTemplate("Revisa $1 con foco en $2. Todo: $ARGUMENTS", "src/a.ts seguridad"), "Revisa src/a.ts con foco en seguridad. Todo: src/a.ts seguridad");
});
