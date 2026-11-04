import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { MAX_EDGE, describeImage, isImagePath, pastedImagePath, prepareImage } from "../src/cli/images.ts";

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#3366aa" } }).png().toBuffer();

test("una imagen pequeña se envía tal cual", async () => {
  const buf = await png(640, 480);
  const img = await prepareImage(buf, "captura.png");
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.resized, false);
  assert.equal(Buffer.from(img.data, "base64").length, buf.length);
  assert.equal(describeImage(img), "captura.png · 640×480");
});

test("una imagen grande se reduce al lado máximo", async () => {
  const img = await prepareImage(await png(4000, 1000), "pantalla.png");
  assert.equal(img.resized, true);
  assert.equal(img.width, MAX_EDGE);
  assert.equal(img.height, 500);
  assert.match(describeImage(img), /reducida/);
});

test("los formatos no nativos se convierten y lo que no es imagen se rechaza", async () => {
  const bmp = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
  const converted = await prepareImage(bmp, "dibujo.tiff"); // extensión no nativa → se recodifica
  assert.ok(["image/png", "image/jpeg"].includes(converted.mimeType));
  await assert.rejects(prepareImage(Buffer.from("no soy una imagen"), "x.png"), /no parece una imagen/);
});

test("reconoce rutas de imagen pegadas o arrastradas", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-img-"));
  try {
    mkdirSync(path.join(dir, "con espacio"));
    const file = path.join(dir, "con espacio", "foto 1.png");
    writeFileSync(file, "x");
    writeFileSync(path.join(dir, "nota.txt"), "x");
    assert.equal(pastedImagePath(`"${file}"`, dir), file);
    assert.equal(pastedImagePath(`'${file}'`, dir), file);
    if (process.platform !== "win32") assert.equal(pastedImagePath(file.replace(/ /g, "\\ "), dir), file);
    assert.equal(pastedImagePath(`file://${encodeURI(file)}`, dir), file);
    assert.equal(pastedImagePath("con espacio/foto 1.png", dir), file);
    assert.equal(pastedImagePath(path.join(dir, "nota.txt"), dir), undefined);
    assert.equal(pastedImagePath(path.join(dir, "no-existe.png"), dir), undefined);
    assert.equal(pastedImagePath(`${file}\n${file}`, dir), undefined);
    assert.ok(isImagePath("A.JPEG") && !isImagePath("a.pdf"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
