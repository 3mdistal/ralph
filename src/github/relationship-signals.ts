import type { IssueRelationshipSnapshot } from "./issue-relationships";
import type { RelationshipSignal } from "./issue-blocking-core";

export type ResolvedRelationshipSignals = {
  signals: RelationshipSignal[];
  hasBodyDepsCoverage: boolean;
  ignoredBodyBlockers: number;
  ignoreReason: "complete" | "partial";
};

export function resolveRelationshipSignals(snapshot: IssueRelationshipSnapshot): ResolvedRelationshipSignals {
  const signals = [...snapshot.signals];
  const githubDepsSignals = signals.filter((signal) => signal.source === "github" && signal.kind === "blocked_by");
  const bodyDepsSignals = signals.filter((signal) => signal.source === "body" && signal.kind === "blocked_by");
  const hasGithubDepsSignals = githubDepsSignals.length > 0;
  const hasGithubDepsCoverage = snapshot.coverage.githubDepsComplete;
  const shouldIgnoreBodyDeps = hasGithubDepsCoverage || (!hasGithubDepsCoverage && hasGithubDepsSignals);
  const filteredSignals = shouldIgnoreBodyDeps
    ? signals.filter((signal) => !(signal.source === "body" && signal.kind === "blocked_by"))
    : signals;
  const hasBodyDepsCoverage = snapshot.coverage.bodyDeps && !shouldIgnoreBodyDeps;
  const ignoredBodyBlockers = shouldIgnoreBodyDeps ? bodyDepsSignals.length : 0;
  const ignoreReason = hasGithubDepsCoverage ? "complete" : "partial";

  const resolvedSignals = [...filteredSignals];
  if (!snapshot.coverage.githubDepsComplete && !hasBodyDepsCoverage) {
    resolvedSignals.push({ source: "github", kind: "blocked_by", state: "unknown" });
  }
  if (!snapshot.coverage.githubSubIssuesComplete) {
    resolvedSignals.push({ source: "github", kind: "sub_issue", state: "unknown" });
  }

  return { signals: resolvedSignals, hasBodyDepsCoverage, ignoredBodyBlockers, ignoreReason };
}
