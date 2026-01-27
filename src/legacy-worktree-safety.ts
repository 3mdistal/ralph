export type LegacyWorktreeSafetySnapshot = {
  validWorktree: boolean;
  detached: boolean;
  branchRef: string | null;
  dirty: boolean;
  baseRef: string | null;
  baseRefAvailable: boolean;
  mergedIntoBase: boolean;
  error?: string;
};

export type LegacyWorktreeSafetyDecision = {
  ok: boolean;
  reason?: string;
};

export function decideLegacyWorktreeSafety(
  snapshot: LegacyWorktreeSafetySnapshot
): LegacyWorktreeSafetyDecision {
  if (!snapshot.validWorktree) return { ok: false, reason: snapshot.error ?? "invalid worktree" };
  if (snapshot.detached || !snapshot.branchRef) return { ok: false, reason: "detached HEAD or missing branch" };
  if (!snapshot.baseRefAvailable) return { ok: false, reason: "base ref not found; run git fetch --all --prune" };
  if (snapshot.dirty) return { ok: false, reason: "worktree has uncommitted changes" };
  if (!snapshot.mergedIntoBase) return { ok: false, reason: `branch not merged into ${snapshot.baseRef}` };
  return { ok: true };
}
