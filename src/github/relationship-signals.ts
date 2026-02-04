import type { IssueRelationshipSnapshot } from "./issue-relationships";
import type { RelationshipSignal } from "./issue-blocking-core";

export type RelationshipResolutionDiagnostics = {
  ignoredBodyBlockers?: { count: number; reason: "complete" | "partial" };
  injectedUnknown?: string[];
};

export type ResolvedRelationshipSignals = {
  signals: RelationshipSignal[];
  hasBodyDepsCoverage: boolean;
  diagnostics?: RelationshipResolutionDiagnostics;
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
  const diagnostics: RelationshipResolutionDiagnostics = {};
  if (ignoredBodyBlockers > 0) {
    diagnostics.ignoredBodyBlockers = { count: ignoredBodyBlockers, reason: ignoreReason };
  }

  const resolvedSignals = [...filteredSignals];
  if (!snapshot.coverage.githubDepsComplete && !hasBodyDepsCoverage) {
    resolvedSignals.push({ source: "github", kind: "blocked_by", state: "unknown" });
    diagnostics.injectedUnknown = [...(diagnostics.injectedUnknown ?? []), "githubDeps"];
  }
  if (!snapshot.coverage.githubSubIssuesComplete) {
    resolvedSignals.push({ source: "github", kind: "sub_issue", state: "unknown" });
    diagnostics.injectedUnknown = [...(diagnostics.injectedUnknown ?? []), "githubSubIssues"];
  }

  return {
    signals: resolvedSignals,
    hasBodyDepsCoverage,
    diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
  };
}
