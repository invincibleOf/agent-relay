import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { InputClosed, InputEditor } from "../src/cli/input.ts";
import { makeStyles, stripAnsi } from "../src/shared/ui.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function setup(historyFile?: string) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
  let screen = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        screen += chunk.toString();
        cb();
      },
    }),
    { columns: 80 },
  );
  const editor = new InputEditor(input, output, makeStyles(false), historyFile);
  editor.start();
  // Cada escritura llega como un bloque, igual que lo envía la terminal.
  const type = async (...parts: string[]) => {
    for (const p of parts) {
      input.write(p);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { editor, type, screen: () => stripAnsi(screen), stop: () => editor.stop() };
}

test("Enter envía una sola línea", async () => {
  const t = setup();
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("hola mundo", "\r");
  assert.equal(await p, "hola mundo");
  t.stop();
});

test("pegar varias líneas no las envía por separado", async () => {
  const t = setup();
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("revisa esto:", " ", PASTE_START + "línea 1\r\nlínea 2\rlínea 3" + PASTE_END, "\r");
  assert.equal(await p, "revisa esto: línea 1\nlínea 2\nlínea 3");
  t.stop();
});

test("un pegado largo se muestra resumido y se envía completo", async () => {
  const t = setup();
  const pasted = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join("\n");
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("explica ", PASTE_START + pasted + PASTE_END);
  assert.match(t.screen(), /\[texto pegado #1 · 40 líneas · \d+ caracteres\]/);
  assert.doesNotMatch(t.screen(), /const x39/);
  await t.type("\r");
  assert.equal(await p, `explica ${pasted}`);
  t.stop();
});

test("borrar el resumen elimina todo el pegado", async () => {
  const t = setup();
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("a ", PASTE_START + "1\n2\n3\n4\n5" + PASTE_END, "\x7f", "b", "\r");
  assert.equal(await p, "a b");
  t.stop();
});

test("\\ + Enter, Option+Enter, Shift+Enter y Ctrl+J insertan saltos de línea", async () => {
  const t = setup();
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("uno\\", "\r", "dos", "\x1b\r", "tres", "\x1b[13;2u", "cuatro", "\n", "cinco", "\r");
  assert.equal(await p, "uno\ndos\ntres\ncuatro\ncinco");
  t.stop();
});

test("en preguntas de una línea el pegado se aplana", async () => {
  const t = setup();
  const p = t.editor.read({ prompt: "? ", multiline: false });
  await t.type(PASTE_START + "1\n2" + PASTE_END, "\r");
  assert.equal(await p, "1 2");
  t.stop();
});

test("edición: flechas, inicio/fin, Ctrl+W y Ctrl+U", async () => {
  const t = setup();
  const p = t.editor.read({ prompt: "› ", multiline: true });
  // "hola mundo" → ← ← ← ← ← inserta "nuevo " → "hola nuevo mundo"; Ctrl+E; Ctrl+W borra "mundo"
  await t.type("hola mundo", "\x1b[D".repeat(5), "nuevo ", "\x05", "\x17", "\r");
  assert.equal(await p, "hola nuevo ");
  const p2 = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("descartar", "\x15", "ok", "\r");
  assert.equal(await p2, "ok");
  t.stop();
});

test("↑ / ↓ recorren el historial y se guarda en disco", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-hist-"));
  const file = path.join(dir, "history.json");
  try {
    const t = setup(file);
    for (const msg of ["primero", "segundo"]) {
      const p = t.editor.read({ prompt: "› ", multiline: true, history: true });
      await t.type(msg, "\r");
      await p;
    }
    const p = t.editor.read({ prompt: "› ", multiline: true, history: true });
    await t.type("\x1b[A", "\x1b[A", "\x1b[B", "\r");
    assert.equal(await p, "segundo");
    t.stop();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["primero", "segundo"]);

    const t2 = setup(file); // el historial persiste entre sesiones
    const p2 = t2.editor.read({ prompt: "› ", multiline: true, history: true });
    await t2.type("\x1b[A", "\r");
    assert.equal(await p2, "segundo");
    t2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl+C borra el texto; dos veces seguidas con el campo vacío cierra", async () => {
  const t = setup();
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("algo", "\x03");
  assert.match(t.screen(), /› $/m);
  await t.type("\x03");
  assert.match(t.screen(), /Ctrl\+C otra vez para salir/);
  const closed = assert.rejects(p, InputClosed);
  await t.type("\x03");
  await closed;
  t.stop();
});

test("Ctrl+D con el campo vacío cierra", async () => {
  const t = setup();
  const closed = assert.rejects(t.editor.read({ prompt: "› ", multiline: true }), InputClosed);
  await t.type("\x04");
  await closed;
  t.stop();
});

test("Ctrl+C fuera de una lectura llama al manejador de interrupción", async () => {
  const t = setup();
  let interrupted = 0;
  t.editor.onInterrupt(() => interrupted++);
  await t.type("ignorado", "\x03");
  assert.equal(interrupted, 1);
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("ok", "\r");
  assert.equal(await p, "ok", "lo escrito mientras el agente trabaja no se cuela");
  t.stop();
});

test("Tab completa /comandos", async () => {
  const t = setup();
  t.editor.setCompletions(() => ["/help", "/model", "/mode", "/new"]);
  const p = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("/he", "\t", "\r");
  assert.equal(await p, "/help ");
  const p2 = t.editor.read({ prompt: "› ", multiline: true });
  await t.type("/mo", "\t", "\t"); // completa el prefijo común ("/mode") y luego muestra las opciones
  assert.match(t.screen(), /\/mode {2}\/model/);
  await t.type("l", "\t", "\r");
  assert.equal(await p2, "/model ");
  t.stop();
});
