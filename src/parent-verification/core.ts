import type { IssueRef } from "../github/issue-ref";
import type { IssueRelationshipSnapshot } from "../github/issue-relationships";
import type { RelationshipSignal } from "../github/issue-blocking-core";

export type ParentVerificationDecision = "verify" | "skip";

export type ParentVerificationEligibility = {
  decision: ParentVerificationDecision;
  reason: string;
  childIssues: IssueRef[];
};

export type ParentVerificationEvidence = {
  kind: "issue" | "pr" | "commit" | "note";
  url: string;
  label?: string;
};

export type ParentVerificationOutput = {
  satisfied: boolean;
  reason?: string;
  evidence?: string[];
  error?: string;
};

export type ParentVerificationPromptInput = {
  repo: string;
  issueNumber: number;
  issueUrl: string;
  childIssues: IssueRef[];
  evidence: ParentVerificationEvidence[];
};

export const PARENT_VERIFY_MARKER = "RALPH_PARENT_VERIFY:";
const MAX_MARKER_JSON_CHARS = 4000;
const MAX_OUTPUT_EVIDENCE = 20;
const MAX_COMMENT_CHARS = 8000;
const MAX_COMMENT_ITEMS = 50;

function dedupeIssues(issues: IssueRef[]): IssueRef[] {
  const seen = new Set<string>();
  const output: IssueRef[] = [];
  for (const issue of issues) {
    const key = `${issue.repo}#${issue.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(issue);
  }
  return output;
}

function sortIssues(issues: IssueRef[]): IssueRef[] {
  return [...issues].sort((a, b) => {
    const repoCompare = a.repo.localeCompare(b.repo);
    if (repoCompare !== 0) return repoCompare;
    return a.number - b.number;
  });
}

function trimEvidenceEntry(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 300 ? trimmed.slice(0, 300).trimEnd() : trimmed;
}

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function evaluateParentVerificationEligibility(params: {
  snapshot: IssueRelationshipSnapshot;
  signals: RelationshipSignal[];
}): ParentVerificationEligibility {
  const childSignals = params.signals.filter((signal) => signal.kind === "sub_issue" && signal.ref);
  const childIssues = sortIssues(dedupeIssues(childSignals.map((signal) => signal.ref!).filter(Boolean)));

  if (params.snapshot.coverage.githubSubIssues !== "complete") {
    return { decision: "skip", reason: "sub-issue coverage incomplete", childIssues };
  }

  if (childIssues.length === 0) {
    return { decision: "skip", reason: "no sub-issues detected", childIssues };
  }

  const hasOpenSubIssue = childSignals.some((signal) => signal.state === "open");
  if (hasOpenSubIssue) {
    return { decision: "skip", reason: "sub-issue still open", childIssues };
  }

  const blockedSignals = params.signals.filter((signal) => signal.kind === "blocked_by");
  const hasOpenBlocked = blockedSignals.some((signal) => signal.state === "open");
  if (hasOpenBlocked) {
    return { decision: "skip", reason: "blocked by open dependency", childIssues };
  }

  const hasUnknown = params.signals.some((signal) => signal.state === "unknown");
  if (hasUnknown) {
    return { decision: "skip", reason: "relationship coverage unknown", childIssues };
  }

  return { decision: "verify", reason: "all sub-issues closed", childIssues };
}

export function buildParentVerificationPrompt(input: ParentVerificationPromptInput): string {
  const childLines = input.childIssues.map((issue) => `- https://github.com/${issue.repo}/issues/${issue.number}`);
  const evidenceLines = input.evidence.map((item) => `- ${item.label ? `${item.label}: ` : ""}${item.url}`);

  return [
    "You are verifying whether a parent issue is already satisfied by its closed sub-issues.",
    "Verification only: do NOT modify files, commit, push, create branches, or open PRs.",
    "If you are unsure or the evidence is insufficient, set satisfied=false.",
    "",
    `Parent issue (#${input.issueNumber}): ${input.issueUrl}`,
    "",
    "Child issues:",
    ...childLines,
    "",
    "Evidence links:",
    ...(evidenceLines.length > 0 ? evidenceLines : ["- (no evidence links available)"]),
    "",
    "Return ONLY the following single-line marker as the final non-empty line:",
    `${PARENT_VERIFY_MARKER} {"version":"v1","satisfied":true|false,"reason":"...","evidence":["..."]}`,
  ].join("\n");
}

export function parseParentVerificationOutput(output: string): ParentVerificationOutput {
  const lines = output.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim());
  const lastLine = nonEmpty[nonEmpty.length - 1];
  if (!lastLine || !lastLine.trimStart().startsWith(PARENT_VERIFY_MARKER)) {
    return { satisfied: false, reason: "missing_marker", error: "missing_marker" };
  }

  const markerLine = lastLine.trim();
  const jsonPart = markerLine.trimStart().slice(PARENT_VERIFY_MARKER.length).trim();
  if (!jsonPart || jsonPart.length > MAX_MARKER_JSON_CHARS) {
    return { satisfied: false, reason: "invalid_marker", error: "marker_too_large" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return { satisfied: false, reason: "invalid_marker", error: "invalid_json" };
  }

  if (!parsed || typeof parsed !== "object" || parsed.version !== "v1") {
    return { satisfied: false, reason: "invalid_marker", error: "invalid_version" };
  }

  const satisfied = typeof parsed.satisfied === "boolean" ? parsed.satisfied : false;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : undefined;
  const evidenceRaw = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence: string[] = [];

  for (const item of evidenceRaw) {
    if (evidence.length >= MAX_OUTPUT_EVIDENCE) break;
    const entry = trimEvidenceEntry(String(item));
    if (entry) evidence.push(entry);
  }

  return {
    satisfied,
    reason,
    evidence: evidence.length ? evidence : undefined,
  };
}

export function buildParentVerificationComment(params: {
  marker: string;
  childIssues: IssueRef[];
  evidence: ParentVerificationEvidence[];
}): string {
  const childLines = sortIssues(dedupeIssues(params.childIssues)).slice(0, MAX_COMMENT_ITEMS).map((issue) => {
    return `- https://github.com/${issue.repo}/issues/${issue.number}`;
  });

  const evidenceLines = params.evidence
    .filter((item) => Boolean(item.url.trim()))
    .slice(0, MAX_COMMENT_ITEMS)
    .map((item) => `- ${item.label ? `${item.label}: ` : ""}${item.url}`);

  const lines = [
    params.marker,
    "Verification complete — no changes required.",
    "",
    "Child issues:",
    ...(childLines.length ? childLines : ["- (none recorded)"]),
    "",
    "Evidence:",
    ...(evidenceLines.length ? evidenceLines : ["- (no evidence links available)"]),
  ];

  return truncateText(lines.join("\n"), MAX_COMMENT_CHARS);
}
