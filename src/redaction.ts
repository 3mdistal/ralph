import { homedir } from "os";

export function redactHomePathForDisplay(value: string): string {
  const pathValue = String(value ?? "");
  const home = homedir();
  if (!home) return pathValue;
  return pathValue.split(home).join("~");
}
