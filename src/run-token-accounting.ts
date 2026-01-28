import { isOpencodeProfilesEnabled, listOpencodeProfileNames } from "./config";
import { resolveOpencodeMessagesRootDir } from "./opencode-messages-root";
import {
  readOpencodeSessionTokenTotalsWithQuality,
  type OpencodeSessionTokenTotals,
  type OpencodeSessionTokenReadResult,
} from "./opencode-session-tokens";
import { isSafeSessionId } from "./session-id";
import {
  listRalphRunSessionIds,
  recordRalphRunSessionTokenTotals,
  recordRalphRunTokenTotals,
  type RalphRunSessionTokenTotalsQuality,
} from "./state";

export type RunTokenAccountingResult = {
  tokensTotal: number | null;
  tokensComplete: boolean;
  sessionCount: number;
  sessions: Array<{ sessionId: string; total: number | null; quality: RalphRunSessionTokenTotalsQuality }>;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_BUDGET_MS = 4_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms (${label})`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function qualityRank(quality: RalphRunSessionTokenTotalsQuality): number {
  switch (quality) {
    case "ok":
      return 5;
    case "unreadable":
      return 4;
    case "timeout":
      return 3;
    case "error":
      return 2;
    case "missing":
      return 1;
    default:
      return 0;
  }
}

function normalizeQuality(result: OpencodeSessionTokenReadResult): RalphRunSessionTokenTotalsQuality {
  const q = result.quality;
  if (q === "ok" || q === "missing" || q === "unreadable") return q;
  return "error";
}

function buildMessagesRootDirCandidates(opencodeProfile: string | null): string[] {
  const roots: string[] = [];
  roots.push(resolveOpencodeMessagesRootDir(opencodeProfile).messagesRootDir);

  if (isOpencodeProfilesEnabled()) {
    for (const name of listOpencodeProfileNames()) {
      roots.push(resolveOpencodeMessagesRootDir(name).messagesRootDir);
    }
  }

  roots.push(resolveOpencodeMessagesRootDir(null).messagesRootDir);
  return dedupe(roots);
}

async function readSessionTotalsAcrossRoots(params: {
  sessionId: string;
  messagesRootDirs: string[];
  timeoutMs: number;
}): Promise<{ totals: OpencodeSessionTokenTotals | null; quality: RalphRunSessionTokenTotalsQuality }> {
  if (!isSafeSessionId(params.sessionId)) {
    return { totals: null, quality: "missing" };
  }

  let best: { totals: OpencodeSessionTokenTotals | null; quality: RalphRunSessionTokenTotalsQuality } = {
    totals: null,
    quality: "missing",
  };

  for (const root of params.messagesRootDirs) {
    let result: OpencodeSessionTokenReadResult;
    try {
      result = await withTimeout(
        readOpencodeSessionTokenTotalsWithQuality({ sessionId: params.sessionId, messagesRootDir: root }),
        params.timeoutMs,
        params.sessionId
      );
    } catch {
      const quality: RalphRunSessionTokenTotalsQuality = "timeout";
      if (qualityRank(quality) > qualityRank(best.quality)) best = { totals: null, quality };
      continue;
    }

    const quality = normalizeQuality(result);
    if (quality === "ok") {
      return { totals: result.totals, quality: "ok" };
    }

    if (qualityRank(quality) > qualityRank(best.quality)) {
      best = { totals: null, quality };
    }
  }

  return best;
}

async function collectWithConcurrency<T>(items: string[], concurrency: number, worker: (id: string) => Promise<T>): Promise<T[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: T[] = [];
  let idx = 0;

  const next = async (): Promise<void> => {
    const current = idx;
    idx += 1;
    if (current >= items.length) return;
    const item = items[current]!;
    results[current] = await worker(item);
    await next();
  };

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

export async function refreshRalphRunTokenTotals(params: {
  runId: string;
  opencodeProfile: string | null;
  timeoutMs?: number;
  concurrency?: number;
  budgetMs?: number;
  messagesRootDirs?: string[];
  at?: string;
}): Promise<RunTokenAccountingResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
  const budgetMs = params.budgetMs ?? DEFAULT_BUDGET_MS;

  try {
    const sessionIds = dedupe(listRalphRunSessionIds(params.runId));
    if (sessionIds.length === 0) {
      recordRalphRunTokenTotals({
        runId: params.runId,
        tokensTotal: null,
        tokensComplete: false,
        sessionCount: 0,
        at: params.at,
      });
      return { tokensTotal: null, tokensComplete: false, sessionCount: 0, sessions: [] };
    }

    const messagesRootDirs =
      params.messagesRootDirs && params.messagesRootDirs.length > 0
        ? dedupe(params.messagesRootDirs)
        : buildMessagesRootDirCandidates(params.opencodeProfile);

    const sessionResults = await withTimeout(
      collectWithConcurrency(sessionIds, concurrency, async (sessionId) => {
        const read = await readSessionTotalsAcrossRoots({ sessionId, messagesRootDirs, timeoutMs });
        const totals = read.quality === "ok" ? read.totals : null;
        recordRalphRunSessionTokenTotals({
          runId: params.runId,
          sessionId,
          tokensInput: totals?.input ?? null,
          tokensOutput: totals?.output ?? null,
          tokensReasoning: totals?.reasoning ?? null,
          tokensTotal: totals?.total ?? null,
          quality: read.quality,
          at: params.at,
        });

        return { sessionId, total: totals?.total ?? null, quality: read.quality };
      }),
      budgetMs,
      `run:${params.runId}`
    );

    let tokensComplete = true;
    let tokensTotal = 0;
    for (const s of sessionResults) {
      if (s.quality !== "ok" || typeof s.total !== "number" || !Number.isFinite(s.total)) {
        tokensComplete = false;
        tokensTotal = 0;
        break;
      }
      tokensTotal += s.total;
    }

    const aggregateTotal = tokensComplete ? tokensTotal : null;
    recordRalphRunTokenTotals({
      runId: params.runId,
      tokensTotal: aggregateTotal,
      tokensComplete,
      sessionCount: sessionResults.length,
      at: params.at,
    });

    return {
      tokensTotal: aggregateTotal,
      tokensComplete,
      sessionCount: sessionResults.length,
      sessions: sessionResults,
    };
  } catch {
    try {
      recordRalphRunTokenTotals({
        runId: params.runId,
        tokensTotal: null,
        tokensComplete: false,
        sessionCount: 0,
        at: params.at,
      });
    } catch {
      // best-effort
    }
    return { tokensTotal: null, tokensComplete: false, sessionCount: 0, sessions: [] };
  }
}
