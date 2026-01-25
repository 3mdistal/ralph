import type { CiDebugSummary } from "./core";

function formatChecks(summary: CiDebugSummary): string {
  const failures = summary.required.filter((check) => check.state === "FAILURE");
  if (failures.length === 0) return "(none)";
  return failures
    .map((check) => {
      const link = check.detailsUrl ? ` (${check.detailsUrl})` : "";
      return `- ${check.name}: ${check.rawState}${link}`;
    })
    .join("\n");
}

export function buildCiDebugPrompt(params: {
  prUrl: string;
  baseRefName?: string | null;
  headSha?: string | null;
  summary: CiDebugSummary;
  remediationContext?: string | null;
}): string {
  const baseRef = params.baseRefName?.trim() || "unknown";
  const headSha = params.headSha?.trim() || "unknown";
  const remediationContext = params.remediationContext?.trim();

  return [
    "You are a dedicated CI-debug run. Focus only on making required checks green.",
    "Do not run planning; start from CI triage and local reproduction.",
    "",
    `PR: ${params.prUrl}`,
    `Base: ${baseRef}`,
    `Head: ${headSha}`,
    "",
    "Failing required checks:",
    formatChecks(params.summary),
    remediationContext ? "" : "",
    remediationContext ? "Failure context:" : "",
    remediationContext ?? "",
    "",
    "If failures look flaky, prefer deterministic reruns before code changes.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
