import { basename } from "path";

export function isSafeSessionId(value: string): boolean {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("..")) return false;
  return basename(value) === value;
}
