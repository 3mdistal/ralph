export type CiDebugCheckState = "SUCCESS" | "PENDING" | "FAILURE" | "UNKNOWN";

export type CiDebugCheck = {
  name: string;
  state: CiDebugCheckState;
  rawState: string;
  detailsUrl?: string | null;
};

export type CiDebugSummary = {
  status: "success" | "pending" | "failure";
  required: CiDebugCheck[];
  available: string[];
};

export type CiDebugCommentAction = "spawn" | "retry" | "waiting" | "success" | "escalated";

export function computeFailureSignature(summary: CiDebugSummary): string {
  const failed = summary.required
    .filter((check) => check.state === "FAILURE")
    .map((check) => `${check.name}:${check.rawState}`)
    .sort();
  return failed.join("|") || "none";
}

function formatChecksForComment(summary: CiDebugSummary): string[] {
  const failures = summary.required.filter((check) => check.state === "FAILURE");
  if (failures.length === 0) return ["- (none)"];
  return failures.map((check) => {
    const suffix = check.detailsUrl ? ` (${check.detailsUrl})` : "";
    return `- ${check.name}: ${check.rawState}${suffix}`;
  });
}

function resolveActionLine(action: CiDebugCommentAction): string {
  if (action === "success") {
    return "Status: Required checks are green. CI-debug complete.";
  }
  if (action === "waiting") {
    return "Status: Required checks are pending. Ralph is waiting for CI to complete.";
  }
  if (action === "escalated") {
    return "Status: CI-debug attempts exhausted; escalating to humans.";
  }
  return "Action: Ralph is spawning a dedicated CI-debug run to make required checks green.";
}

export function buildCiDebugStatusComment(params: {
  marker: string;
  prUrl: string;
  baseRefName?: string | null;
  headSha?: string | null;
  summary: CiDebugSummary;
  action: CiDebugCommentAction;
  attemptCount: number;
  sessionId?: string | null;
  note?: string | null;
}): string {
  const baseRef = params.baseRefName?.trim() || "unknown";
  const headSha = params.headSha?.trim() || "unknown";
  const lines = [
    params.marker,
    `CI-debug status for PR: ${params.prUrl}`,
    "",
    `Base: ${baseRef}`,
    `Head: ${headSha}`,
    "",
    "Failing required checks:",
    ...formatChecksForComment(params.summary),
    "",
    resolveActionLine(params.action),
  ];

  if (params.attemptCount > 0) {
    lines.push(`Attempt: ${params.attemptCount}`);
  }
  if (params.sessionId?.trim()) {
    lines.push(`Session: ${params.sessionId.trim()}`);
  }
  if (params.note?.trim()) {
    lines.push("", params.note.trim());
  }

  return lines.join("\n");
}
