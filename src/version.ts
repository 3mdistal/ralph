import { readFileSync } from "fs";

export function getRalphVersion(): string | null {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}
