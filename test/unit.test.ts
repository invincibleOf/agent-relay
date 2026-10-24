import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTemplate } from "../src/cli/commands.ts";
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

test("expandTemplate sustituye $ARGUMENTS y posicionales", () => {
  assert.equal(expandTemplate("Revisa $1 con foco en $2. Todo: $ARGUMENTS", "src/a.ts seguridad"), "Revisa src/a.ts con foco en seguridad. Todo: src/a.ts seguridad");
});
