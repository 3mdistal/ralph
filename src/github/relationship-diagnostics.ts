import { shouldLog } from "../logging";
import { formatIssueRef, type IssueRef } from "./issue-ref";
import type { RelationshipResolutionDiagnostics } from "./relationship-signals";

const IGNORED_BODY_DEPS_LOG_INTERVAL_MS = 6 * 60 * 60 * 1000;

type LogParams = {
  repo: string;
  issue: IssueRef;
  diagnostics?: RelationshipResolutionDiagnostics;
  area: string;
};

export function formatRelationshipDiagnostics(params: {
  issue: IssueRef;
  diagnostics?: RelationshipResolutionDiagnostics;
}): string | null {
  const ignored = params.diagnostics?.ignoredBodyBlockers;
  if (!ignored) return null;
  return (
    `Ignoring ${ignored.count} body blocker(s) for ${formatIssueRef(params.issue)} due to ${ignored.reason} ` +
    "GitHub dependency coverage."
  );
}

export function logRelationshipDiagnostics(params: LogParams): void {
  const message = formatRelationshipDiagnostics({ issue: params.issue, diagnostics: params.diagnostics });
  if (!message) return;
  const key = `deps:body:${params.repo}#${params.issue.number}`;
  if (!shouldLog(key, IGNORED_BODY_DEPS_LOG_INTERVAL_MS)) return;
  console.log(`[ralph:${params.area}:${params.repo}] ${message}`);
}
