import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownStream, inline } from "../src/cli/markdown.ts";
import { makeStyles, stripAnsi, visibleWidth } from "../src/shared/ui.ts";

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

// Casos reales que dejaban marcadores sin formatear.
const LEFTOVER = /\*\*|(^|\s)\*\S|(^|\s)__\w|\[[^\]]+\]\(/;

test("la negrita puede contener código", () => {
  for (const text of ["**El archivo `pom.xml`** define todo.", "- **`GET /api/tareas`**: lista.", "1. **`LiveClientService`**: consulta."]) {
    const out = stripAnsi(render([text, "\n"]));
    assert.doesNotMatch(out, LEFTOVER, out);
    assert.ok(render([text, "\n"]).includes(on.cyan(text.match(/`([^`]+)`/)![1])));
  }
});

test("los * y _ dentro del código no se interpretan", () => {
  const out = render(["Usa `a*b*c` y `snake_case_x`, pero **sí** esto.\n"]);
  assert.equal(stripAnsi(out), "Usa a*b*c y snake_case_x, pero sí esto.\n");
});

test("soporta __negrita__ y _cursiva_ sin tocar snake_case", () => {
  const out = stripAnsi(render(["__negrita__ y _cursiva_ pero snake_case_name y MAX_TOKENS quedan igual.\n"]));
  assert.equal(out, "negrita y cursiva pero snake_case_name y MAX_TOKENS quedan igual.\n");
});

test("un * suelto no rompe la negrita", () => {
  assert.equal(stripAnsi(render(["**Nota:** calcula **x * y** primero.\n"])), "Nota: calcula x * y primero.\n");
});

test("los enlaces no se confunden con los códigos de color", () => {
  const out = stripAnsi(render(["Usa *SSE* (ver [la guía](https://x.dev/sse)).\n"]));
  assert.equal(out, "Usa SSE (ver la guía (https://x.dev/sse)).\n");
});

test("los encabezados con negrita interna quedan en negrita completa", () => {
  const out = render(["## Resumen de **coach-lol**\n"]);
  assert.equal(stripAnsi(out), "Resumen de coach-lol\n");
  // Un solo cierre de negrita, al final: los ** internos no la apagan a mitad de línea.
  assert.equal(out.split("\x1b[22m").length - 1, 1);
});

test("el resultado visible no depende de la fragmentación del streaming", () => {
  const doc = [
    "## Resumen de **coach-lol**",
    "",
    "**Coach LoL** es una app **Spring Boot 3.4** que da consejos.",
    "1. **`LiveClientService`**: consulta `/allgamedata` cada *5 s*.",
    "- **Throttle:** máximo una llamada cada **45 s**; ver `MIN_INTERVAL_MS`.",
    "- Usa *SSE* y no WebSocket (ver [la guía](https://docs.spring.io/sse)).",
    "> **Importante:** cada llamada se *factura*.",
    "| **Archivo** | Uso |",
    "Variables como snake_case_name no cambian. Fin con **negrita**.",
    "",
  ].join("\n");
  const visible = (s: string) => s.replace(/\x1b\[(\d+(;\d+)*)m/g, (_, c: string) => `<${c}>`);
  const expected = stripAnsi(render([doc]));
  assert.doesNotMatch(expected, LEFTOVER);
  // Fragmentaciones deterministas: de 1 a 13 caracteres, y alternadas.
  for (let size = 1; size <= 13; size++) {
    const chunks: string[] = [];
    for (let i = 0, k = 0; i < doc.length; k++) {
      const n = size + (k % 3);
      chunks.push(doc.slice(i, i + n));
      i += n;
    }
    const out = render(chunks);
    assert.equal(stripAnsi(out), expected, `tamaño ${size}`);
    assert.doesNotMatch(visible(out), /\*\*/);
  }
});

// ─── Tablas ──────────────────────────────────────────────────────────────────

function renderW(chunks: string[], width: number) {
  let out = "";
  const md = new MarkdownStream(on, (s) => (out += s), () => width);
  for (const c of chunks) md.push(c);
  md.flush();
  return out;
}

const TABLE = [
  "Comparación:",
  "",
  "| Proveedor | Estado | Notas |",
  "|:---|:---:|---:|",
  "| **Claude Code** | ✅ | usa `claude-agent-acp` |",
  "| OpenCode | ⚠️ | preset `opencode` |",
  "",
  "Fin.",
  "",
].join("\n");

test("las tablas se dibujan con bordes, sin | ni ---, y con formato en las celdas", () => {
  const out = renderW([TABLE], 80);
  const plain = stripAnsi(out);
  assert.match(plain, /┌─+┬─+┬─+┐/);
  assert.match(plain, /│ Proveedor\s+│ Estado │\s+Notas │/);
  assert.match(plain, /│ Claude Code\s+│   ✅   │ usa claude-agent-acp │/, "centrado y a la derecha según el separador");
  assert.doesNotMatch(plain, /\|/);
  assert.doesNotMatch(plain, /---|\*\*|`/);
  assert.ok(out.includes(on.bold("Claude Code")) && out.includes(on.cyan("claude-agent-acp")));
  assert.match(plain, /^Comparación:\n\n┌/);
  assert.match(plain, /┘\n\nFin\.\n$/);
});

test("todas las filas de la tabla tienen el mismo ancho visible, también con emojis", () => {
  const rowsOf = (out: string) => stripAnsi(out).split("\n").filter((l) => /^[┌├└│]/.test(l));
  const lines = rowsOf(renderW([TABLE], 80));
  assert.equal(new Set(lines.map((l) => visibleWidth(l))).size, 1, lines.join("\n"));
});

test("en una terminal angosta las celdas se ajustan sin salirse del ancho", () => {
  const doc = "| Campo | Descripción |\n|---|---|\n| `token` | Token de 256 bits que el daemon guarda solo como hash **SHA-256** y compara en tiempo constante |\n";
  const out = renderW([doc], 40);
  const lines = stripAnsi(out).split("\n").filter(Boolean);
  for (const l of lines) assert.ok(visibleWidth(l) <= 40, `${visibleWidth(l)}: ${l}`);
  assert.ok(lines.length > 5, "la descripción ocupa varias líneas");
  assert.match(stripAnsi(out), /SHA-256/);
  // Los estilos se cierran al final de cada línea y se reabren en la siguiente.
  for (const l of out.split("\n")) assert.equal((l.match(/\x1b\[1m/g) ?? []).length >= (l.match(/\x1b\[22m/g) ?? []).length - 1, true);
});

test("la tabla se ve igual sin importar cómo llegue en streaming", () => {
  const whole = renderW([TABLE], 70);
  assert.equal(renderW(TABLE.split(""), 70), whole);
  for (let size = 2; size <= 9; size++) {
    const chunks: string[] = [];
    for (let i = 0; i < TABLE.length; i += size) chunks.push(TABLE.slice(i, i + size));
    assert.equal(renderW(chunks, 70), whole, `tamaño ${size}`);
  }
});

test("| dentro de `código` o escapado no separa columnas; filas incompletas se rellenan", () => {
  const plain = stripAnsi(renderW(["| Cmd | Uso |\n|---|---|\n| `a | b` | tubería |\n| x \\| y |\n"], 60));
  assert.match(plain, /│ a \| b\s+│ tubería │/);
  assert.match(plain, /│ x \| y\s+│\s+│/);
});

test("sin fila separadora no es una tabla y se muestra como texto", () => {
  assert.equal(stripAnsi(renderW(["| solo | barras |\nsigue\n"], 60)), "| solo | barras |\nsigue\n");
});

test("una tabla al final de la respuesta, sin salto de línea, se dibuja al terminar", () => {
  const plain = stripAnsi(renderW(["| a | b |\n|---|---|\n| 1 | 2 |"], 60));
  assert.match(plain, /│ 1 │ 2 │\n└───┴───┘\n$/);
});
