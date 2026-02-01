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

export type ParentVerificationChild = {
  ref: IssueRef;
  url: string;
  title?: string;
  state: "open" | "closed" | "unknown";
  evidence: ParentVerificationEvidence[];
};

export type ParentVerificationOutput = {
  valid: boolean;
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

export const PARENT_VERIFY_MARKER = "RALPH_PARENT_VERIFY: ";
const MAX_MARKER_LINE_CHARS = 8192;
const MAX_MARKER_JSON_CHARS = 4096;
const MAX_OUTPUT_EVIDENCE = 20;
const MAX_COMMENT_CHARS = 8000;
const MAX_COMMENT_ITEMS = 50;
const MAX_EVIDENCE_CHARS = 300;
const ALLOWED_MARKER_KEYS = new Set(["version", "satisfied", "reason", "evidence"]);

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
  return trimmed.length > MAX_EVIDENCE_CHARS ? trimmed.slice(0, MAX_EVIDENCE_CHARS).trimEnd() : trimmed;
}

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function evaluateParentVerificationEligibility(params: {
  snapshot: IssueRelationshipSnapshot;
  signals: RelationshipSignal[];
}): ParentVerificationEligibility {
  const childSignals = params.signals.filter((signal) => signal.kind === "sub_issue" && signal.ref);
  const childIssues = sortIssues(dedupeIssues(childSignals.map((signal) => signal.ref!).filter(Boolean)));

  if (!params.snapshot.coverage.githubSubIssuesComplete) {
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
  const childIssues = Array.isArray((input as any)?.childIssues) ? (input as any).childIssues : [];
  const evidence = Array.isArray((input as any)?.evidence) ? (input as any).evidence : [];

  const childLines = childIssues.map((issue: any) => `- https://github.com/${issue.repo}/issues/${issue.number}`);
  const evidenceLines = evidence.map((item: any) => `- ${item.label ? `${item.label}: ` : ""}${item.url}`);

  return [
    "You are verifying whether a parent issue is already satisfied by its closed sub-issues.",
    "Verification only: do NOT modify files, commit, push, create branches, or open PRs.",
    "If you are unsure or the evidence is insufficient, set satisfied=false.",
    "", 
    `Parent issue: ${input.issueUrl}`,
    "",
    "Child issues:",
    ...childLines,
    "",
    "Evidence links:",
    ...(evidenceLines.length > 0 ? evidenceLines : ["- (no evidence links available)"]),
    "",
    "Return ONLY the following single-line marker as the final non-empty line.",
    "The final non-empty line must start with the exact prefix `RALPH_PARENT_VERIFY: ` (no leading whitespace).",
    `${PARENT_VERIFY_MARKER}{"version":"v1","satisfied":true|false,"reason":"...","evidence":["..."]}`,
  ].join("\n");
}

export function parseParentVerificationOutput(output: string): ParentVerificationOutput {
  const lines = output.split(/\r?\n/);
  let lastNonEmpty: string | null = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    lastNonEmpty = line;
    break;
  }

  if (!lastNonEmpty) {
    return { valid: false, satisfied: false, reason: "missing_marker", error: "missing_marker" };
  }

  if (lastNonEmpty !== lastNonEmpty.trimStart()) {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "leading_whitespace" };
  }

  if (!lastNonEmpty.startsWith(PARENT_VERIFY_MARKER)) {
    return { valid: false, satisfied: false, reason: "missing_marker", error: "missing_marker" };
  }

  if (lastNonEmpty.length > MAX_MARKER_LINE_CHARS) {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "marker_too_large" };
  }

  const jsonPart = lastNonEmpty.slice(PARENT_VERIFY_MARKER.length).trim();
  if (!jsonPart || jsonPart.length > MAX_MARKER_JSON_CHARS) {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "marker_too_large" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "invalid_json" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== "v1") {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "invalid_version" };
  }

  const keys = Object.keys(parsed);
  if (keys.some((key) => !ALLOWED_MARKER_KEYS.has(key))) {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "invalid_keys" };
  }

  if (typeof parsed.satisfied !== "boolean") {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "invalid_satisfied" };
  }

  if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "invalid_reason" };
  }

  const satisfied = parsed.satisfied;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : undefined;
  if (parsed.evidence !== undefined && !Array.isArray(parsed.evidence)) {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "invalid_evidence" };
  }

  const evidenceRaw = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (evidenceRaw.length > MAX_OUTPUT_EVIDENCE) {
    return { valid: false, satisfied: false, reason: "invalid_marker", error: "evidence_too_large" };
  }

  const evidence: string[] = [];
  for (const item of evidenceRaw) {
    if (typeof item !== "string") {
      return { valid: false, satisfied: false, reason: "invalid_marker", error: "invalid_evidence" };
    }
    const entry = trimEvidenceEntry(item);
    if (entry) evidence.push(entry);
  }

  return {
    valid: true,
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

  const evidenceLines = sortEvidence(params.evidence)
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

export function getParentVerificationEligibility(
  snapshot: IssueRelationshipSnapshot,
  signals: RelationshipSignal[]
): { eligible: boolean; reason: string; childRefs: IssueRef[] } {
  const result = evaluateParentVerificationEligibility({ snapshot, signals });
  return {
    eligible: result.decision === "verify",
    reason: result.reason,
    childRefs: result.childIssues,
  };
}

export function hasRequiredParentEvidence(children: ParentVerificationChild[]): boolean {
  if (!children || children.length === 0) return false;
  return children.every((child) => child.evidence.some((item) => item.kind === "pr" || item.kind === "commit"));
}

function evidenceKindOrder(kind: ParentVerificationEvidence["kind"]): number {
  switch (kind) {
    case "issue":
      return 0;
    case "pr":
      return 1;
    case "commit":
      return 2;
    case "note":
      return 3;
    default:
      return 9;
  }
}

function normalizeEvidenceUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.replace(/\/+$/, "") : trimmed;
}

function sortEvidence(evidence: ParentVerificationEvidence[]): ParentVerificationEvidence[] {
  const normalized = evidence
    .map((item) => ({ ...item, url: normalizeEvidenceUrl(item.url) }))
    .filter((item) => Boolean(item.url));

  const seen = new Set<string>();
  const deduped: ParentVerificationEvidence[] = [];
  for (const item of normalized) {
    const key = `${item.kind}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.sort((a, b) => {
    const kindCompare = evidenceKindOrder(a.kind) - evidenceKindOrder(b.kind);
    if (kindCompare !== 0) return kindCompare;
    const urlCompare = a.url.localeCompare(b.url);
    if (urlCompare !== 0) return urlCompare;
    return (a.label ?? "").localeCompare(b.label ?? "");
  });
}
