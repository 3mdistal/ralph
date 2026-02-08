import type { MergeConflictFailureClass } from "../../github/merge-conflict-comment";
import type { SessionResult } from "../../session";

const MAX_REASON_LENGTH = 280;

function normalizeReason(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function boundedReason(input: string): string {
  const normalized = normalizeReason(input);
  if (normalized.length <= MAX_REASON_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

function isPermissionText(text: string): boolean {
  return /(permission denied|access denied|not permitted|insufficient permissions|write access to .* denied|authentication failed|403\b|forbidden|could not read from remote repository)/i.test(
    text
  );
}

function isRuntimeText(text: string): boolean {
  return /(timed?\s*out|timeout|temporar|rate limit|429\b|50[234]\b|econnreset|etimedout|enotfound|network error|service unavailable|worker failure|runtime-error)/i.test(
    text
  );
}

export function classifyMergeConflictFailure(params: {
  kind: "agent-run-failed" | "wait-failed" | "merge-state-dirty" | "merge-state-timeout";
  reason?: string;
  sessionResult?: SessionResult;
}): { failureClass: MergeConflictFailureClass; failureReason?: string } {
  const sessionText = params.sessionResult?.output ? ` ${params.sessionResult.output}` : "";
  const source = `${params.reason ?? ""}${sessionText}`.trim();
  const reason = boundedReason(params.reason ?? source);

  if (params.kind === "merge-state-dirty") {
    return { failureClass: "merge-content", failureReason: reason || "Merge conflicts remain after recovery attempt." };
  }

  if (params.kind === "merge-state-timeout" || params.kind === "wait-failed") {
    return { failureClass: "runtime", failureReason: reason || "Timed out while waiting for updated PR state." };
  }

  if (isPermissionText(source)) {
    return { failureClass: "permission", failureReason: reason || "Permission denied while updating PR branch." };
  }

  if (
    params.sessionResult?.watchdogTimeout ||
    params.sessionResult?.stallTimeout ||
    params.sessionResult?.guardrailTimeout ||
    isRuntimeText(source)
  ) {
    return { failureClass: "runtime", failureReason: reason || "Temporary runtime failure during recovery run." };
  }

  return {
    failureClass: "tooling",
    failureReason: reason || "Tooling failure during merge-conflict recovery run.",
  };
}
