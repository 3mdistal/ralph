import { getActiveRalphRunId, getRalphRunTokenTotals } from "./state";
import { refreshRalphRunTokenTotals } from "./run-token-accounting";

export type RunTokenTotals = {
  tokensTotal: number | null;
  tokensComplete: boolean;
  sessionCount: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_BUDGET_MS = 4_000;

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

export async function readRunTokenTotals(params: {
  repo: string;
  issue: string;
  opencodeProfile: string | null;
  timeoutMs?: number;
  concurrency?: number;
  budgetMs?: number;
}): Promise<RunTokenTotals> {
  const issueNumber = parseIssueNumber(params.issue);
  if (!issueNumber) return { tokensTotal: null, tokensComplete: false, sessionCount: 0 };

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
  const budgetMs = params.budgetMs ?? DEFAULT_BUDGET_MS;

  try {
    const runId = getActiveRalphRunId({ repo: params.repo, issueNumber });
    if (!runId) return { tokensTotal: null, tokensComplete: false, sessionCount: 0 };

    const stored = getRalphRunTokenTotals(runId);
    if (stored && stored.tokensComplete && typeof stored.tokensTotal === "number") {
      return { tokensTotal: stored.tokensTotal, tokensComplete: true, sessionCount: stored.sessionCount };
    }

    const refreshed = await refreshRalphRunTokenTotals({
      runId,
      opencodeProfile: params.opencodeProfile,
      timeoutMs,
      concurrency,
      budgetMs,
    });

    return {
      tokensTotal: refreshed.tokensTotal,
      tokensComplete: refreshed.tokensComplete,
      sessionCount: refreshed.sessionCount,
    };
  } catch {
    return { tokensTotal: null, tokensComplete: false, sessionCount: 0 };
  }
}
