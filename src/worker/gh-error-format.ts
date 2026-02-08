import { redactSensitiveText } from "../redaction";

import { summarizeForNote } from "./run-notes";

function stringifyText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();

  // Bun ShellError frequently uses Uint8Array for stdout/stderr.
  // Calling .toString() on Uint8Array returns a comma-separated byte list,
  // so decode as UTF-8 first.
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(value).trim();
    } catch {
      return "";
    }
  }

  if (typeof (value as any)?.toString === "function") {
    try {
      return String((value as any).toString()).trim();
    } catch {
      return "";
    }
  }

  try {
    return String(value).trim();
  } catch {
    return "";
  }
}

function stringifyGhOutput(value: unknown): string {
  const text = stringifyText(value);
  return text ? redactSensitiveText(text).trim() : "";
}

export function buildGhErrorSearchText(error: any): string {
  const parts: string[] = [];
  const message = String(error?.message ?? "").trim();
  const stderr = stringifyGhOutput(error?.stderr);
  const stdout = stringifyGhOutput(error?.stdout);

  if (message) parts.push(message);
  if (stderr) parts.push(stderr);
  if (stdout) parts.push(stdout);

  return parts.join("\n").trim();
}

export function formatGhError(error: any): string {
  const lines: string[] = [];

  const command = String(error?.ghCommand ?? error?.command ?? "").trim();
  const redactedCommand = command ? redactSensitiveText(command).trim() : "";
  if (redactedCommand) lines.push(`Command: ${redactedCommand}`);

  const exitCodeRaw = error?.exitCode ?? error?.code ?? null;
  const exitCode = exitCodeRaw === null || exitCodeRaw === undefined ? "" : String(exitCodeRaw).trim();
  if (exitCode) lines.push(`Exit code: ${exitCode}`);

  const message = String(error?.message ?? "").trim();
  if (message) lines.push(message);

  const stderr = stringifyGhOutput(error?.stderr);
  const stdout = stringifyGhOutput(error?.stdout);

  if (stderr) lines.push("", "stderr:", summarizeForNote(stderr, 1600));
  if (stdout) lines.push("", "stdout:", summarizeForNote(stdout, 1600));

  return lines.join("\n").trim();
}
