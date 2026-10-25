import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownStream, inline } from "../src/cli/markdown.ts";
import { makeStyles, stripAnsi } from "../src/shared/ui.ts";

const on = makeStyles(true);

function render(chunks: string[], enabled = true) {
  let out = "";
  const md = new MarkdownStream(makeStyles(enabled), (s) => (out += s));
  for (const c of chunks) md.push(c);
  md.flush();
  return out;
}

test("sin TTY el texto pasa sin cambios", () => {
  const text = "## Título\n- **uno** y `dos`\nKEY=valor\n";
  assert.equal(render([text], false), text);
});

test("da formato a encabezados, listas, código en línea y negrita", () => {
  const out = render(["## Cómo funciona\n- usa **SSE** y `SseEmitter`\n1. primero\n"]);
  assert.equal(stripAnsi(out), "Cómo funciona\n• usa SSE y SseEmitter\n1. primero\n");
  assert.ok(out.includes(on.bold("SSE")));
  assert.ok(out.includes(on.cyan("SseEmitter")));
});

test("el resultado no depende de cómo lleguen los fragmentos", () => {
  const text = "Esto es **muy importante** y usa `npm test` al final.\n## Siguiente\n- punto\n";
  const whole = render([text]);
  const pieces = render(text.split(""));
  const chunked = render(["Esto es **muy ", "impor", "tante** y usa `npm ", "test` al final.\n## Sig", "uiente\n- pu", "nto\n"]);
  assert.equal(pieces, whole);
  assert.equal(chunked, whole);
});

test("los bloques de código conservan su contenido literal", () => {
  const out = stripAnsi(render(["```java\n", "int **x** = 1;\n", "```\n", "fin\n"]));
  assert.equal(out, "  ┌─ java \n  │ int **x** = 1;\n  └─\nfin\n");
});

test("emite texto antes de que termine la línea", () => {
  let out = "";
  const md = new MarkdownStream(on, (s) => (out += s));
  md.push("Una respuesta larga que todavía ");
  assert.ok(stripAnsi(out).startsWith("Una respuesta larga que"));
  md.push("sigue\n");
  md.flush();
  assert.equal(stripAnsi(out), "Una respuesta larga que todavía sigue\n");
});

test("inline formatea enlaces", () => {
  assert.equal(stripAnsi(inline("ver [docs](https://x.dev)", on)), "ver docs (https://x.dev)");
});
