type FingerprintState = {
  seenAtMs: number[];
  opened: boolean;
};

type CircuitState = {
  byFingerprint: Map<string, FingerprintState>;
};

export type IssueFailureCircuitDecision =
  | {
      action: "none";
      fingerprint: string;
      normalizedReason: string;
      recentCount: number;
    }
  | {
      action: "backoff";
      fingerprint: string;
      normalizedReason: string;
      recentCount: number;
      backoffMs: number;
      opened: boolean;
    }
  | {
      action: "open";
      fingerprint: string;
      normalizedReason: string;
      recentCount: number;
    };

export type IssueFailureCircuitBreaker = {
  recordFailure: (params: {
    repo: string;
    issueNumber: number;
    reason: string;
    nowMs: number;
  }) => IssueFailureCircuitDecision;
  clearIssue: (params: { repo: string; issueNumber: number }) => void;
};

export type IssueFailureCircuitConfig = {
  windowMs: number;
  openAfterCount: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  jitterMs: number;
};

const DEFAULT_CONFIG: IssueFailureCircuitConfig = {
  windowMs: 10 * 60_000,
  openAfterCount: 4,
  backoffBaseMs: 15_000,
  backoffCapMs: 5 * 60_000,
  jitterMs: 5_000,
};

function parsePositiveInt(value: string | undefined): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}

function loadConfig(): IssueFailureCircuitConfig {
  const env = (globalThis as any)?.process?.env ?? {};
  const windowMs = parsePositiveInt(env.RALPH_ISSUE_FAILURE_CB_WINDOW_MS) ?? DEFAULT_CONFIG.windowMs;
  const openAfterCount = parsePositiveInt(env.RALPH_ISSUE_FAILURE_CB_OPEN_AFTER) ?? DEFAULT_CONFIG.openAfterCount;
  const backoffBaseMs = parsePositiveInt(env.RALPH_ISSUE_FAILURE_CB_BACKOFF_BASE_MS) ?? DEFAULT_CONFIG.backoffBaseMs;
  const backoffCapMs = parsePositiveInt(env.RALPH_ISSUE_FAILURE_CB_BACKOFF_CAP_MS) ?? DEFAULT_CONFIG.backoffCapMs;
  const jitterMs = parsePositiveInt(env.RALPH_ISSUE_FAILURE_CB_JITTER_MS) ?? DEFAULT_CONFIG.jitterMs;

  return {
    windowMs,
    openAfterCount: Math.max(2, openAfterCount),
    backoffBaseMs,
    backoffCapMs: Math.max(backoffBaseMs, backoffCapMs),
    jitterMs,
  };
}

function issueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function normalizeFailureReason(value: string): string {
  const compact = String(value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8,}/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return compact || "failed";
}

function fingerprintForReason(reason: string): string {
  let hash = 2166136261;
  for (let i = 0; i < reason.length; i += 1) {
    hash ^= reason.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pruneTimes(times: number[], nowMs: number, windowMs: number): number[] {
  const floor = nowMs - windowMs;
  return times.filter((ts) => ts >= floor);
}

function deterministicJitter(maxJitterMs: number, seed: string): number {
  if (maxJitterMs <= 0) return 0;
  const parsed = Number.parseInt(fingerprintForReason(seed), 16);
  const value = Number.isFinite(parsed) ? parsed : 0;
  return Math.abs(value) % (maxJitterMs + 1);
}

export function createIssueFailureCircuitBreaker(config: Partial<IssueFailureCircuitConfig> = {}): IssueFailureCircuitBreaker {
  const resolved = { ...loadConfig(), ...config };
  const states = new Map<string, CircuitState>();

  const recordFailure: IssueFailureCircuitBreaker["recordFailure"] = ({ repo, issueNumber, reason, nowMs }) => {
    const key = issueKey(repo, issueNumber);
    const state = states.get(key) ?? { byFingerprint: new Map<string, FingerprintState>() };
    states.set(key, state);

    const normalizedReason = normalizeFailureReason(reason);
    const fingerprint = fingerprintForReason(normalizedReason);
    const fpState = state.byFingerprint.get(fingerprint) ?? { seenAtMs: [], opened: false };

    fpState.seenAtMs = pruneTimes(fpState.seenAtMs, nowMs, resolved.windowMs);
    fpState.seenAtMs.push(nowMs);
    const recentCount = fpState.seenAtMs.length;

    if (recentCount >= resolved.openAfterCount && !fpState.opened) {
      fpState.opened = true;
      state.byFingerprint.set(fingerprint, fpState);
      return {
        action: "open",
        fingerprint,
        normalizedReason,
        recentCount,
      };
    }

    state.byFingerprint.set(fingerprint, fpState);

    if (recentCount <= 1) {
      return {
        action: "none",
        fingerprint,
        normalizedReason,
        recentCount,
      };
    }

    const exponential = resolved.backoffBaseMs * Math.pow(2, Math.max(0, recentCount - 2));
    const jitter = deterministicJitter(resolved.jitterMs, `${key}|${fingerprint}|${recentCount}`);
    const backoffMs = Math.min(resolved.backoffCapMs, Math.round(exponential + jitter));

    return {
      action: "backoff",
      fingerprint,
      normalizedReason,
      recentCount,
      backoffMs,
      opened: fpState.opened,
    };
  };

  const clearIssue: IssueFailureCircuitBreaker["clearIssue"] = ({ repo, issueNumber }) => {
    states.delete(issueKey(repo, issueNumber));
  };

  return { recordFailure, clearIssue };
}
