import { getActiveRalphRunId, listRalphRunSessionIds } from "./state";
import {
  readOpencodeSessionTokenTotalsWithQuality,
  type OpencodeSessionTokenReadResult,
} from "./opencode-session-tokens";
import { resolveOpencodeMessagesRootDir } from "./opencode-messages-root";

export type RunTokenTotals = {
  tokensTotal: number | null;
  tokensComplete: boolean;
  sessionCount: number;
};

export type SessionTokenReadResult = {
  total: number | null;
  quality: "ok" | "missing" | "unreadable" | "timeout";
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 3;

function parseIssueNumber(issueRef: string): number | null {
  const match = issueRef.match(/#(\d+)$/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

export function computeAggregateTokens(sessionTotals: Array<{ total: number | null }>): {
  tokensTotal: number | null;
  tokensComplete: boolean;
} {
  if (sessionTotals.length === 0) return { tokensTotal: null, tokensComplete: false };

  let total = 0;
  for (const entry of sessionTotals) {
    if (typeof entry.total !== "number" || !Number.isFinite(entry.total)) {
      return { tokensTotal: null, tokensComplete: false };
    }
    total += entry.total;
  }

  return { tokensTotal: total, tokensComplete: true };
}

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

async function readSessionTotals(params: {
  sessionId: string;
  messagesRootDir: string;
  timeoutMs: number;
}): Promise<SessionTokenReadResult> {
  try {
    const result = await withTimeout(
      readOpencodeSessionTokenTotalsWithQuality({ sessionId: params.sessionId, messagesRootDir: params.messagesRootDir }),
      params.timeoutMs,
      params.sessionId
    );

    if (result.quality !== "ok") {
      return { total: null, quality: result.quality };
    }

    return { total: result.totals.total, quality: "ok" };
  } catch {
    return { total: null, quality: "timeout" };
  }
}

async function collectSessionTotals(opts: {
  sessionIds: string[];
  messagesRootDir: string;
  timeoutMs: number;
  concurrency: number;
  cache?: Map<string, Promise<SessionTokenReadResult>>;
}): Promise<SessionTokenReadResult[]> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const results: SessionTokenReadResult[] = [];
  let idx = 0;

  const cache = opts.cache ?? new Map<string, Promise<SessionTokenReadResult>>();

  const readCached = (sessionId: string): Promise<SessionTokenReadResult> => {
    const existing = cache.get(sessionId);
    if (existing) return existing;
    const promise = readSessionTotals({ sessionId, messagesRootDir: opts.messagesRootDir, timeoutMs: opts.timeoutMs });
    cache.set(sessionId, promise);
    return promise;
  };

  const next = async (): Promise<void> => {
    const current = idx;
    idx += 1;
    if (current >= opts.sessionIds.length) return;

    const sessionId = opts.sessionIds[current]!;
    results[current] = await readCached(sessionId);
    await next();
  };

  const workers = Array.from({ length: Math.min(concurrency, opts.sessionIds.length) }, () => next());
  await Promise.all(workers);
  return results;
}

export async function readRunTokenTotals(params: {
  repo: string;
  issue: string;
  opencodeProfile: string | null;
  timeoutMs?: number;
  concurrency?: number;
  cache?: Map<string, Promise<SessionTokenReadResult>>;
}): Promise<RunTokenTotals> {
  try {
    const issueNumber = parseIssueNumber(params.issue);
    if (!issueNumber) return { tokensTotal: null, tokensComplete: false, sessionCount: 0 };

    const runId = getActiveRalphRunId({ repo: params.repo, issueNumber });
    if (!runId) return { tokensTotal: null, tokensComplete: false, sessionCount: 0 };

    const sessionIds = listRalphRunSessionIds(runId);
    if (sessionIds.length === 0) return { tokensTotal: null, tokensComplete: false, sessionCount: 0 };

    const messagesRootDir = resolveOpencodeMessagesRootDir(params.opencodeProfile).messagesRootDir;
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
    const sessionTotals = await collectSessionTotals({
      sessionIds,
      messagesRootDir,
      timeoutMs,
      concurrency,
      cache: params.cache,
    });

    const aggregate = computeAggregateTokens(sessionTotals.map((entry) => ({ total: entry.total })));
    return { tokensTotal: aggregate.tokensTotal, tokensComplete: aggregate.tokensComplete, sessionCount: sessionTotals.length };
  } catch {
    return { tokensTotal: null, tokensComplete: false, sessionCount: 0 };
  }
}
