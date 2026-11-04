import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Imagen lista para enviarse al agente (bloque ACP `image` o resultado MCP). */
export interface ImageAttachment {
  name: string;
  mimeType: string;
  /** Contenido en base64. */
  data: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Se redujo o convirtió para respetar los límites del modelo. */
  resized: boolean;
}

/** Formatos que los modelos aceptan directamente. */
const NATIVE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Formatos que se convierten a PNG (requiere sharp). */
const CONVERTIBLE = new Set([".bmp", ".tif", ".tiff", ".avif", ".svg"]);

/** Lado mayor máximo: más grande no mejora el análisis y gasta tokens. */
export const MAX_EDGE = 2000;
/** Tamaño máximo enviado (≈5 MB en base64, el límite habitual de las APIs). */
export const MAX_BYTES = 3_750_000;
/** Archivo más grande que se intenta procesar. */
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

export function isImagePath(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext in NATIVE || CONVERTIBLE.has(ext);
}

type SharpFn = (typeof import("sharp"))["default"];
let sharpPromise: Promise<SharpFn | null> | undefined;
/** sharp es opcional: si no está instalado, las imágenes grandes no se pueden reducir. */
function loadSharp(): Promise<SharpFn | null> {
  sharpPromise ??= import("sharp").then((m) => m.default).catch(() => null);
  return sharpPromise;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** Valida, reduce si hace falta y codifica una imagen. */
export async function prepareImage(buffer: Buffer, name: string): Promise<ImageAttachment> {
  if (buffer.length > MAX_INPUT_BYTES) throw new Error(`${name} pesa ${kb(buffer.length)}; el máximo es ${kb(MAX_INPUT_BYTES)}`);
  const ext = path.extname(name).toLowerCase();
  const native = NATIVE[ext] ?? sniffMime(buffer);
  const sharp = await loadSharp();

  if (!sharp) {
    if (!native) throw new Error(`${name}: formato no soportado sin sharp (usa PNG, JPG, GIF o WebP, o ejecuta npm install en agent-relay)`);
    if (buffer.length > MAX_BYTES) {
      throw new Error(`${name} pesa ${kb(buffer.length)} y sharp no está instalado para reducirla (npm install en la carpeta de agent-relay)`);
    }
    return { name, mimeType: native, data: buffer.toString("base64"), bytes: buffer.length, resized: false };
  }

  const img = sharp(buffer, { animated: false, limitInputPixels: 300_000_000 });
  let meta;
  try {
    meta = await img.metadata();
  } catch {
    throw new Error(`${name} no parece una imagen válida`);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const tooBig = Math.max(width, height) > MAX_EDGE || buffer.length > MAX_BYTES;

  if (native && !tooBig && !(meta.orientation && meta.orientation > 1)) {
    return { name, mimeType: native, data: buffer.toString("base64"), bytes: buffer.length, width, height, resized: false };
  }

  // Reduce, corrige la orientación y recodifica: PNG si conserva transparencia y cabe; si no, JPEG.
  const base = sharp(buffer, { limitInputPixels: 300_000_000 }).rotate().resize({
    width: MAX_EDGE,
    height: MAX_EDGE,
    fit: "inside",
    withoutEnlargement: true,
  });
  let out = await base.clone().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  let mimeType = "image/png";
  if (out.data.length > MAX_BYTES || (!meta.hasAlpha && native === "image/jpeg")) {
    for (const quality of [85, 72, 60]) {
      out = await base.clone().flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      mimeType = "image/jpeg";
      if (out.data.length <= MAX_BYTES) break;
    }
  }
  if (out.data.length > MAX_BYTES) throw new Error(`${name} sigue pesando ${kb(out.data.length)} después de reducirla`);
  return {
    name,
    mimeType,
    data: out.data.toString("base64"),
    bytes: out.data.length,
    width: out.info.width,
    height: out.info.height,
    resized: true,
  };
}

export async function loadImageFile(absPath: string): Promise<ImageAttachment> {
  const size = statSync(absPath).size;
  if (size > MAX_INPUT_BYTES) throw new Error(`${path.basename(absPath)} pesa ${kb(size)}; el máximo es ${kb(MAX_INPUT_BYTES)}`);
  return prepareImage(readFileSync(absPath), path.basename(absPath));
}

function sniffMime(b: Buffer): string | undefined {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export function describeImage(img: ImageAttachment): string {
  const dims = img.width && img.height ? `${img.width}×${img.height}` : kb(img.bytes);
  return `${img.name} · ${dims}${img.resized ? " · reducida" : ""}`;
}

/**
 * Si lo pegado es la ruta de un archivo de imagen (arrastrar y soltar en la
 * terminal), devuelve la ruta absoluta. Acepta comillas (Windows Terminal) y
 * espacios escapados con \ (Terminal.app, iTerm2).
 */
export function pastedImagePath(text: string, cwd: string): string | undefined {
  let t = text.trim();
  if (!t || t.includes("\n")) return undefined;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  else if (process.platform !== "win32") t = t.replace(/\\(.)/g, "$1");
  if (t.startsWith("file://")) {
    try {
      t = decodeURIComponent(new URL(t).pathname);
      if (/^\/[A-Za-z]:\//.test(t)) t = t.slice(1);
    } catch {
      return undefined;
    }
  }
  const abs = path.resolve(cwd, t);
  if (!isImagePath(abs)) return undefined;
  try {
    return existsSync(abs) && statSync(abs).isFile() ? abs : undefined;
  } catch {
    return undefined;
  }
}

// ─── Portapapeles ────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; stdout: Buffer }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "buffer", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout ?? Buffer.alloc(0) }),
    );
  });
}

/** Lee una imagen del portapapeles del sistema. Devuelve null si no hay. */
export async function readClipboardImage(): Promise<Buffer | null> {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-clip-"));
  const file = path.join(dir, "clip.png");
  try {
    if (process.platform === "darwin") {
      const script = [
        `set f to (open for access POSIX file "${file}" with write permission)`,
        "try",
        "write (the clipboard as «class PNGf») to f",
        "end try",
        "close access f",
      ];
      await run("osascript", script.flatMap((l) => ["-e", l]));
    } else if (process.platform === "win32") {
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; " +
        "$i = [System.Windows.Forms.Clipboard]::GetImage(); " +
        `if ($i -ne $null) { $i.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`;
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps]);
    } else {
      const wayland = await run("wl-paste", ["--type", "image/png"]);
      if (wayland.ok && wayland.stdout.length) return wayland.stdout;
      const x11 = await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
      return x11.ok && x11.stdout.length ? x11.stdout : null;
    }
    if (!existsSync(file)) return null;
    const data = readFileSync(file);
    return data.length ? data : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
