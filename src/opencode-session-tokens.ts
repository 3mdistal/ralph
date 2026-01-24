import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { extractProviderId, extractRole } from "./opencode-message-utils";

type OpencodeMessage = {
  providerID?: unknown;
  role?: unknown;
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
};

export type OpencodeSessionTokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type TokenAccumulator = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

function getDefaultOpencodeMessagesRootDir(): string {
  return join(homedir(), ".local/share/opencode/storage/message");
}

function toFiniteNumber(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  return value;
}

function createTokenAccumulator(): TokenAccumulator {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function applyMessageTokens(
  acc: TokenAccumulator,
  msg: OpencodeMessage,
  opts: { providerID?: string; includeCache: boolean }
): void {
  const role = extractRole(msg);
  if (role && role !== "assistant") return;

  const msgProvider = extractProviderId(msg);
  if (opts.providerID && msgProvider && msgProvider !== opts.providerID) return;

  acc.input += toFiniteNumber(msg?.tokens?.input);
  acc.output += toFiniteNumber(msg?.tokens?.output);
  acc.reasoning += toFiniteNumber(msg?.tokens?.reasoning);

  if (opts.includeCache) {
    acc.cacheRead += toFiniteNumber(msg?.tokens?.cache?.read);
    acc.cacheWrite += toFiniteNumber(msg?.tokens?.cache?.write);
  }
}

function finalizeTokenTotals(acc: TokenAccumulator, includeCache: boolean): OpencodeSessionTokenTotals {
  const totals: OpencodeSessionTokenTotals = {
    input: acc.input,
    output: acc.output,
    reasoning: acc.reasoning,
    total: acc.input + acc.output + acc.reasoning,
  };

  if (includeCache) {
    totals.cacheRead = acc.cacheRead;
    totals.cacheWrite = acc.cacheWrite;
  }

  return totals;
}

function normalizeProviderID(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isValidSessionId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return false;
  if (trimmed.includes("..")) return false;
  return true;
}

async function listSessionMessageFiles(sessionDir: string): Promise<string[]> {
  if (!existsSync(sessionDir)) return [];

  let entries: Array<{ name: string; isFile(): boolean }> = [];
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("msg_") && entry.name.endsWith(".json"))
    .map((entry) => join(sessionDir, entry.name));
}

export async function readOpencodeSessionTokenTotals(opts: {
  sessionId: string;
  messagesRootDir?: string;
  /** Optional provider filter; if unset, counts all providers. */
  providerID?: string;
  includeCache?: boolean;
}): Promise<OpencodeSessionTokenTotals> {
  const includeCache = opts.includeCache === true;
  const providerID = normalizeProviderID(opts.providerID);
  const acc = createTokenAccumulator();

  if (!isValidSessionId(opts.sessionId)) {
    return finalizeTokenTotals(acc, includeCache);
  }

  const messagesRootDir = opts.messagesRootDir ?? getDefaultOpencodeMessagesRootDir();
  const sessionDir = join(messagesRootDir, opts.sessionId);
  const files = await listSessionMessageFiles(sessionDir);

  for (const path of files) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }

    let msg: OpencodeMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }

    applyMessageTokens(acc, msg, { providerID, includeCache });
  }

  return finalizeTokenTotals(acc, includeCache);
}
