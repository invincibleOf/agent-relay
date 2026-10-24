import { readFileSync } from "node:fs";

let cached: string | undefined;

export function packageVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    cached = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached ?? "0.0.0";
}
