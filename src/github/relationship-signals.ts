import type { IssueRelationshipSnapshot } from "./issue-relationships";
import type { RelationshipSignal } from "./issue-blocking-core";

function assertNever(value: never): never {
  throw new Error(`Unexpected relationship coverage state: ${String(value)}`);
}

function shouldIgnoreBodyDepsByCoverage(coverage: IssueRelationshipSnapshot["coverage"]["githubDeps"]): boolean {
  switch (coverage) {
    case "complete":
    case "partial":
      return true;
    case "unavailable":
      return false;
    default:
      return assertNever(coverage);
  }
}

function ignoredBodyReason(coverage: IssueRelationshipSnapshot["coverage"]["githubDeps"]): "complete" | "partial" {
  switch (coverage) {
    case "complete":
      return "complete";
    case "partial":
    case "unavailable":
      return "partial";
    default:
      return assertNever(coverage);
  }
}

function shouldInjectDepsUnknown(coverage: IssueRelationshipSnapshot["coverage"]["githubDeps"]): boolean {
  switch (coverage) {
    case "complete":
      return false;
    case "partial":
    case "unavailable":
      return true;
    default:
      return assertNever(coverage);
  }
}

function shouldInjectSubIssueUnknown(coverage: IssueRelationshipSnapshot["coverage"]["githubSubIssues"]): boolean {
  switch (coverage) {
    case "complete":
      return false;
    case "partial":
    case "unavailable":
      return true;
    default:
      return assertNever(coverage);
  }
}

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
  const shouldIgnoreBodyDeps = shouldIgnoreBodyDepsByCoverage(snapshot.coverage.githubDeps);
  const filteredSignals = shouldIgnoreBodyDeps
    ? signals.filter((signal) => !(signal.source === "body" && signal.kind === "blocked_by"))
    : signals;
  const hasBodyDepsCoverage = snapshot.coverage.bodyDeps && !shouldIgnoreBodyDeps;
  const ignoredBodyBlockers = shouldIgnoreBodyDeps ? bodyDepsSignals.length : 0;
  const ignoreReason = ignoredBodyReason(snapshot.coverage.githubDeps);
  const diagnostics: RelationshipResolutionDiagnostics = {};
  if (ignoredBodyBlockers > 0) {
    diagnostics.ignoredBodyBlockers = { count: ignoredBodyBlockers, reason: ignoreReason };
  }

  const resolvedSignals = [...filteredSignals];
  if (shouldInjectDepsUnknown(snapshot.coverage.githubDeps) && !hasBodyDepsCoverage) {
    resolvedSignals.push({ source: "github", kind: "blocked_by", state: "unknown" });
    diagnostics.injectedUnknown = [...(diagnostics.injectedUnknown ?? []), "githubDeps"];
  }
  if (shouldInjectSubIssueUnknown(snapshot.coverage.githubSubIssues)) {
    resolvedSignals.push({ source: "github", kind: "sub_issue", state: "unknown" });
    diagnostics.injectedUnknown = [...(diagnostics.injectedUnknown ?? []), "githubSubIssues"];
  }

  return {
    signals: resolvedSignals,
    hasBodyDepsCoverage,
    diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
  };
}
