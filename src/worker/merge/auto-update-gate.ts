type PullRequestMergeStateLite = {
  number: number;
  mergeStateStatus: string | null;
  baseRefName: string;
  isCrossRepository: boolean;
  headRepoFullName: string;
  headRefName: string;
};

function buildAutoUpdateKey(repo: string, prNumber: number): string {
  return `autoUpdateBehind:${repo}:${prNumber}`;
}

export function shouldAttemptProactiveUpdate(params: {
  repo: string;
  pr: PullRequestMergeStateLite;
  botBranch: string;
  normalizeGitRef: (ref: string) => string;
}): { ok: boolean; reason?: string } {
  const pr = params.pr;
  if (pr.mergeStateStatus !== "BEHIND") {
    return { ok: false, reason: `Merge state is ${pr.mergeStateStatus ?? "unknown"}` };
  }

  const baseRef = params.normalizeGitRef(pr.baseRefName);
  const botBranch = params.normalizeGitRef(params.botBranch);
  if (baseRef && baseRef !== botBranch) {
    return { ok: false, reason: `PR base branch is ${pr.baseRefName}` };
  }

  if (pr.isCrossRepository || pr.headRepoFullName !== params.repo) {
    return { ok: false, reason: "PR head repo is not the same as base repo" };
  }

  if (!pr.headRefName) {
    return { ok: false, reason: "PR missing head ref" };
  }

  return { ok: true };
}

export function shouldRateLimitAutoUpdate(params: {
  repo: string;
  prNumber: number;
  minMinutes: number;
  getIdempotencyPayload: (key: string) => string | null;
  now?: () => number;
}): boolean {
  const now = params.now ?? (() => Date.now());
  const key = buildAutoUpdateKey(params.repo, params.prNumber);
  let payload: string | null = null;

  try {
    payload = params.getIdempotencyPayload(key);
  } catch {
    return false;
  }

  if (!payload) return false;

  try {
    const parsed = JSON.parse(payload) as { lastAttemptAt?: number };
    const lastAttemptAt = typeof parsed?.lastAttemptAt === "number" ? parsed.lastAttemptAt : 0;
    if (!lastAttemptAt) return false;
    const expiresMs = params.minMinutes * 60_000;
    return now() - lastAttemptAt < expiresMs;
  } catch {
    return false;
  }
}

export function recordAutoUpdateAttempt(params: {
  repo: string;
  prNumber: number;
  minMinutes: number;
  upsertIdempotencyKey: (input: { key: string; scope: string; payloadJson: string }) => void;
  now?: () => number;
}): void {
  const key = buildAutoUpdateKey(params.repo, params.prNumber);
  const payload = JSON.stringify({ lastAttemptAt: (params.now ?? (() => Date.now()))(), minMinutes: params.minMinutes });
  try {
    params.upsertIdempotencyKey({ key, scope: "auto-update-behind", payloadJson: payload });
  } catch {
    // best-effort
  }
}

export function recordAutoUpdateFailure(params: {
  repo: string;
  prNumber: number;
  minMinutes: number;
  upsertIdempotencyKey: (input: { key: string; scope: string; payloadJson: string }) => void;
  now?: () => number;
}): void {
  const key = buildAutoUpdateKey(params.repo, params.prNumber);
  const payload = JSON.stringify({
    lastAttemptAt: (params.now ?? (() => Date.now()))(),
    minMinutes: params.minMinutes,
    status: "failed",
  });
  try {
    params.upsertIdempotencyKey({ key, scope: "auto-update-behind", payloadJson: payload });
  } catch {
    // best-effort
  }
}
