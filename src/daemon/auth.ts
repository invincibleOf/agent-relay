import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Genera un token aleatorio de 256 bits y su hash para el archivo de configuración. */
export function generateToken(): { token: string; sha256: string } {
  const token = `relay_${randomBytes(32).toString("base64url")}`;
  return { token, sha256: sha256Hex(token) };
}

/** Valida `Authorization: Bearer <token>` contra la lista de hashes en tiempo constante. */
export function isAuthorized(req: IncomingMessage, allowedHashes: string[]): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const presented = Buffer.from(sha256Hex(match[1].trim()), "hex");
  let ok = false;
  for (const hex of allowedHashes) {
    const expected = Buffer.from(hex, "hex");
    // Recorre todos los hashes para no filtrar cuál coincidió por tiempo.
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) ok = true;
  }
  return ok;
}
