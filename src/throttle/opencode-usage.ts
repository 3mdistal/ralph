import { homedir } from "os";
import { join } from "path";
import { readdir, readFile, stat } from "fs/promises";

export interface OpenCodeUsageTotals {
  rolling5hTokens: number;
  weeklyTokens: number;
  filesRead: number;
  filesSkipped: number;
  parseErrors: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toCreatedAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds.
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function extractUsageTokens(message: any): number {
  const tokens = message?.tokens;
  if (!tokens || typeof tokens !== "object") return 0;

  const input = toFiniteNumber(tokens.input) ?? 0;
  const output = toFiniteNumber(tokens.output) ?? 0;
  const reasoning = toFiniteNumber(tokens.reasoning) ?? 0;

  return input + output + reasoning;
}

async function* walkMessageFiles(rootDir: string): AsyncGenerator<string> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMessageFiles(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("msg_")) continue;
    if (!entry.name.endsWith(".json")) continue;
    yield full;
  }
}

export function resolveOpenCodeMessageRoot(homeDir: string = homedir()): string {
  return join(homeDir, ".local", "share", "opencode", "storage", "message");
}

export async function readOpenCodeUsageTotals(opts: {
  providerID: string;
  rolling5hStartMs: number;
  weeklyStartMs: number;
  homeDir?: string;
}): Promise<OpenCodeUsageTotals | null> {
  const homeDir = opts.homeDir ?? homedir();
  const rootDir = resolveOpenCodeMessageRoot(homeDir);

  const earliestStartMs = Math.min(opts.rolling5hStartMs, opts.weeklyStartMs);

  let rolling5hTokens = 0;
  let weeklyTokens = 0;
  let filesRead = 0;
  let filesSkipped = 0;
  let parseErrors = 0;

  let filePaths: AsyncGenerator<string>;
  try {
    filePaths = walkMessageFiles(rootDir);
  } catch {
    return null;
  }

  try {
    for await (const filePath of filePaths) {
      try {
        const st = await stat(filePath);
        if (st.mtimeMs < earliestStartMs) continue;
      } catch {
        filesSkipped++;
        continue;
      }

      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        filesSkipped++;
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parseErrors++;
        continue;
      }

      filesRead++;

      if (parsed?.providerID !== opts.providerID) continue;
      if (parsed?.role !== "assistant") continue;

      const createdAtMs = toCreatedAtMs(parsed?.time?.created);
      if (!createdAtMs) continue;
      if (createdAtMs < earliestStartMs) continue;

      const tokens = extractUsageTokens(parsed);
      if (createdAtMs >= opts.weeklyStartMs) weeklyTokens += tokens;
      if (createdAtMs >= opts.rolling5hStartMs) rolling5hTokens += tokens;
    }
  } catch {
    // If OpenCode storage is missing or unreadable, treat as unavailable.
    return null;
  }

  return {
    rolling5hTokens,
    weeklyTokens,
    filesRead,
    filesSkipped,
    parseErrors,
  };
}
