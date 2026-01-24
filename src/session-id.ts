import { basename } from "path";

export function isSafeSessionId(value: string): boolean {
  const normalized = String(value ?? "").trim();
  if (!normalized) return false;
  if (normalized === "." || normalized === "..") return false;
  if (normalized.includes("/") || normalized.includes("\\")) return false;
  if (normalized.includes("..")) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) return false;
  return basename(normalized) === normalized;
}
