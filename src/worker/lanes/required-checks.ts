export type RequiredCheckState = "SUCCESS" | "PENDING" | "FAILURE" | "UNKNOWN";

export type PrCheck = {
  name: string;
  state: RequiredCheckState;
  rawState: string;
  detailsUrl?: string | null;
};

export type RequiredChecksSummary = {
  status: "success" | "pending" | "failure";
  required: Array<{ name: string; state: RequiredCheckState; rawState: string; detailsUrl?: string | null }>;
  available: string[];
};

export type CiGateEvaluation = {
  status: "pass" | "pending" | "fail";
  timedOut: boolean;
  requiredChecks: string[];
  required: Array<{ name: string; state: RequiredCheckState; rawState: string; detailsUrl?: string | null }>;
  missingRequired: string[];
  availableContexts: string[];
  representativeUrl: string | null;
};

export type FailedCheck = {
  name: string;
  state: RequiredCheckState;
  rawState: string;
  detailsUrl?: string | null;
};

export type FailedCheckLog = FailedCheck & {
  runId?: string;
  runUrl?: string;
  logExcerpt?: string;
};

export type RestrictionEntry = { login?: string | null; slug?: string | null };

export type RestrictionList = {
  users?: RestrictionEntry[] | null;
  teams?: RestrictionEntry[] | null;
  apps?: RestrictionEntry[] | null;
};

export type CheckRunsResponse = {
  check_runs?: Array<{ name?: string | null }> | null;
};

export type CommitStatusResponse = {
  statuses?: Array<{ context?: string | null }> | null;
};

export type RepoDetails = {
  default_branch?: string | null;
};

export type PullRequestDetails = {
  number?: number | null;
  url?: string | null;
  merged?: boolean | null;
  merged_at?: string | null;
  base?: { ref?: string | null } | null;
  head?: { ref?: string | null; sha?: string | null; repo?: { full_name?: string | null } | null } | null;
};

export type PullRequestDetailsNormalized = {
  number: number;
  url: string;
  merged: boolean;
  baseRefName: string;
  headRefName: string;
  headRepoFullName: string;
  headSha: string;
};

export type GitRef = {
  object?: { sha?: string | null } | null;
};

export type RequiredChecksGuidanceInput = {
  repo: string;
  branch: string;
  requiredChecks: string[];
  missingChecks: string[];
  availableChecks: string[];
};

export type BranchProtectionDecisionKind = "ok" | "defer" | "fail";

export type BranchProtectionDecision = {
  kind: BranchProtectionDecisionKind;
  missingChecks: string[];
};

export type CheckLogResult = {
  runId?: string;
  runUrl?: string;
  logExcerpt?: string;
};

export type RemediationFailureContext = {
  summary: RequiredChecksSummary;
  failedChecks: FailedCheck[];
  logs: FailedCheckLog[];
  logWarnings: string[];
  commands: string[];
};

const REQUIRED_CHECKS_BACKOFF_MULTIPLIER = 1.5;
export const REQUIRED_CHECKS_MAX_POLL_MS = 120_000;
export const REQUIRED_CHECKS_JITTER_PCT = 0.2;
export const REQUIRED_CHECKS_LOG_INTERVAL_MS = 60_000;
export const REQUIRED_CHECKS_DEFER_RETRY_MS = 60_000;
export const REQUIRED_CHECKS_DEFER_LOG_INTERVAL_MS = 60_000;

const MAIN_MERGE_OVERRIDE_LABEL = "allow-main";
const CI_ONLY_PATH_PREFIXES = [".github/workflows/", ".github/actions/"] as const;
const CI_ONLY_PATH_EXACT = [".github/action.yml", ".github/action.yaml"] as const;
const CI_LABEL_KEYWORDS = ["ci", "build", "infra"] as const;

export const __TEST_ONLY_DEFAULT_BRANCH = "__default_branch__";
export const __TEST_ONLY_DEFAULT_SHA = "__default_sha__";

export function __buildRepoDefaultBranchResponse(): RepoDetails {
  return { default_branch: __TEST_ONLY_DEFAULT_BRANCH };
}

export function __buildGitRefResponse(sha: string): GitRef {
  return { object: { sha } };
}

export function __buildCheckRunsResponse(names: string[]): CheckRunsResponse {
  return { check_runs: names.map((name) => ({ name })) };
}

export function __computeRequiredChecksDelayForTests(
  params: Parameters<typeof computeRequiredChecksDelay>[0]
): ReturnType<typeof computeRequiredChecksDelay> {
  return computeRequiredChecksDelay(params);
}

export function __summarizeRequiredChecksForTests(
  allChecks: PrCheck[],
  requiredChecks: string[]
): RequiredChecksSummary {
  return summarizeRequiredChecks(allChecks, requiredChecks);
}

export function __formatRequiredChecksGuidanceForTests(input: RequiredChecksGuidanceInput): string {
  return formatRequiredChecksGuidance(input);
}

export function __evaluateCiGateForTests(params: {
  allChecks: PrCheck[];
  requiredChecks: string[];
  timedOut?: boolean;
}): CiGateEvaluation {
  return evaluateCiGate(params);
}

export function __formatCiGateReasonForTests(evaluation: CiGateEvaluation, maxLen = 400): string {
  return formatCiGateReason(evaluation, maxLen);
}

export function __decideBranchProtectionForTests(input: {
  requiredChecks: string[];
  availableChecks: string[];
}): BranchProtectionDecision {
  return decideBranchProtection(input);
}

export function __isCiOnlyChangeSetForTests(files: string[]): boolean {
  return isCiOnlyChangeSet(files);
}

export function __isCiRelatedIssueForTests(labels: string[]): boolean {
  return isCiRelatedIssue(labels);
}

export function toSortedUniqueStrings(values: Array<string | null | undefined>): string[] {
  const normalized = values.map((value) => (value ?? "").trim()).filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}

export function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function normalizeEnabledFlag(value: { enabled?: boolean | null } | boolean | null | undefined): boolean {
  if (typeof value === "boolean") return value;
  return Boolean(value?.enabled);
}

export function normalizeRestrictions(
  source: RestrictionList | null | undefined
): { users: string[]; teams: string[]; apps: string[] } | null {
  const users = toSortedUniqueStrings(source?.users?.map((entry) => entry?.login ?? "") ?? []);
  const teams = toSortedUniqueStrings(source?.teams?.map((entry) => entry?.slug ?? "") ?? []);
  const apps = toSortedUniqueStrings(source?.apps?.map((entry) => entry?.slug ?? "") ?? []);
  if (users.length === 0 && teams.length === 0 && apps.length === 0) return null;
  return { users, teams, apps };
}

export function hasBypassAllowances(source: RestrictionList | null | undefined): boolean {
  const normalized = normalizeRestrictions(source);
  if (!normalized) return false;
  return normalized.users.length > 0 || normalized.teams.length > 0 || normalized.apps.length > 0;
}

export function extractPullRequestNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:$|\b|\/)/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function isCiOnlyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized) return false;
  if (CI_ONLY_PATH_EXACT.includes(normalized as (typeof CI_ONLY_PATH_EXACT)[number])) return true;
  return CI_ONLY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isCiOnlyChangeSet(files: string[]): boolean {
  const normalized = files.map((file) => file.trim()).filter(Boolean);
  if (normalized.length === 0) return false;
  return normalized.every((file) => isCiOnlyPath(file));
}

export function isCiRelatedIssue(labels: string[]): boolean {
  return labels.some((label) => {
    const normalized = label.toLowerCase();
    return CI_LABEL_KEYWORDS.some((keyword) => {
      const re = new RegExp(`(^|[-_/])${keyword}($|[-_/])`);
      return re.test(normalized);
    });
  });
}

export function normalizeRequiredCheckState(raw: string | null | undefined): RequiredCheckState {
  const val = String(raw ?? "").toUpperCase();
  if (!val) return "UNKNOWN";
  if (val === "SUCCESS") return "SUCCESS";

  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"].includes(val)) {
    return "FAILURE";
  }

  return "PENDING";
}

export function summarizeRequiredChecks(allChecks: PrCheck[], requiredChecks: string[]): RequiredChecksSummary {
  const available = Array.from(new Set(allChecks.map((c) => c.name))).sort();

  const required = requiredChecks.map((name) => {
    const match = allChecks.find((c) => c.name === name);
    if (!match) return { name, state: "UNKNOWN" as const, rawState: "missing" };
    return { name, state: match.state, rawState: match.rawState, detailsUrl: match.detailsUrl };
  });

  if (requiredChecks.length === 0) {
    return { status: "success", required: [], available };
  }

  const hasFailure = required.some((c) => c.state === "FAILURE");
  if (hasFailure) return { status: "failure", required, available };

  const allSuccess = required.length > 0 && required.every((c) => c.state === "SUCCESS");
  if (allSuccess) return { status: "success", required, available };

  return { status: "pending", required, available };
}

export function evaluateCiGate(params: {
  allChecks: PrCheck[];
  requiredChecks: string[];
  timedOut?: boolean;
}): CiGateEvaluation {
  const summary = summarizeRequiredChecks(params.allChecks, params.requiredChecks);
  const timedOut = Boolean(params.timedOut);
  const missingRequired = summary.required.filter((check) => check.rawState === "missing").map((check) => check.name);
  const representativeUrl = summary.required.map((check) => check.detailsUrl).find(Boolean) ?? null;

  let status: CiGateEvaluation["status"];
  if (summary.status === "success") {
    status = "pass";
  } else if (summary.status === "failure") {
    status = "fail";
  } else {
    status = timedOut && params.requiredChecks.length > 0 ? "fail" : "pending";
  }

  return {
    status,
    timedOut,
    requiredChecks: [...params.requiredChecks],
    required: summary.required,
    missingRequired,
    availableContexts: summary.available,
    representativeUrl,
  };
}

export function evaluateCiGateFromSummary(params: {
  summary: RequiredChecksSummary;
  requiredChecks: string[];
  timedOut?: boolean;
}): CiGateEvaluation {
  const timedOut = Boolean(params.timedOut);
  const missingRequired = params.summary.required
    .filter((check) => check.rawState === "missing")
    .map((check) => check.name);
  const representativeUrl = params.summary.required.map((check) => check.detailsUrl).find(Boolean) ?? null;

  let status: CiGateEvaluation["status"];
  if (params.summary.status === "success") {
    status = "pass";
  } else if (params.summary.status === "failure") {
    status = "fail";
  } else {
    status = timedOut && params.requiredChecks.length > 0 ? "fail" : "pending";
  }

  return {
    status,
    timedOut,
    requiredChecks: [...params.requiredChecks],
    required: params.summary.required,
    missingRequired,
    availableContexts: params.summary.available,
    representativeUrl,
  };
}

export function formatCiGateReason(evaluation: CiGateEvaluation, maxLen = 400): string {
  const mapped = evaluation.required.map((check) => `${check.name}:${check.state}`).join(",") || "(none)";
  const missing = evaluation.missingRequired.join(",") || "(none)";
  const available = evaluation.availableContexts.join(",") || "(none)";
  const timedOut = evaluation.timedOut ? "yes" : "no";
  const reason = `required=${mapped}; status=${evaluation.status}; timed_out=${timedOut}; missing=${missing}; available=${available}`;
  if (reason.length <= maxLen) return reason;
  return `${reason.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function formatCiGateDiagnostics(evaluation: CiGateEvaluation): string {
  const lines: string[] = [];
  lines.push("Deterministic CI required-check evaluation");
  lines.push(`Gate status: ${evaluation.status}`);
  lines.push(`Timed out: ${evaluation.timedOut ? "yes" : "no"}`);
  lines.push(`Required checks: ${evaluation.requiredChecks.join(", ") || "(none)"}`);

  lines.push("Required mapping:");
  if (evaluation.required.length === 0) {
    lines.push("- (none)");
  } else {
    for (const check of evaluation.required) {
      const details = check.detailsUrl ? ` (${check.detailsUrl})` : "";
      lines.push(`- ${check.name}: ${check.state} (${check.rawState})${details}`);
    }
  }

  lines.push(`Missing required contexts: ${evaluation.missingRequired.join(", ") || "(none)"}`);
  lines.push(`Available check contexts: ${evaluation.availableContexts.join(", ") || "(none)"}`);
  lines.push(
    "Next steps: trigger CI on this branch (push a commit or rerun workflows), or update repos[].requiredChecks (set [] to disable gating)."
  );
  return lines.join("\n");
}

export function applyRequiredChecksJitter(valueMs: number, jitterPct = REQUIRED_CHECKS_JITTER_PCT): number {
  const clamped = Math.max(1000, valueMs);
  const variance = clamped * jitterPct;
  const delta = (Math.random() * 2 - 1) * variance;
  return Math.max(1000, Math.round(clamped + delta));
}

export function buildRequiredChecksSignature(summary: RequiredChecksSummary): string {
  return JSON.stringify({
    status: summary.status,
    required: summary.required.map((check) => ({
      name: check.name,
      state: check.state,
      rawState: check.rawState,
    })),
  });
}

export function computeRequiredChecksDelay(params: {
  baseIntervalMs: number;
  maxIntervalMs: number;
  attempt: number;
  lastSignature: string | null;
  nextSignature: string;
  pending: boolean;
}): { delayMs: number; nextAttempt: number; reason: "progress" | "backoff" } {
  if (!params.pending) {
    return { delayMs: params.baseIntervalMs, nextAttempt: 0, reason: "progress" };
  }

  if (params.lastSignature && params.lastSignature === params.nextSignature) {
    const nextAttempt = params.attempt + 1;
    const delay = Math.min(
      Math.round(params.baseIntervalMs * Math.pow(REQUIRED_CHECKS_BACKOFF_MULTIPLIER, nextAttempt)),
      params.maxIntervalMs
    );
    return { delayMs: delay, nextAttempt, reason: "backoff" };
  }

  return { delayMs: params.baseIntervalMs, nextAttempt: 0, reason: "progress" };
}

export function formatRequiredChecksForHumans(summary: RequiredChecksSummary): string {
  const lines: string[] = [];
  lines.push(`Required checks: ${summary.required.map((c) => c.name).join(", ") || "(none)"}`);
  for (const chk of summary.required) {
    const details = chk.detailsUrl ? ` (${chk.detailsUrl})` : "";
    lines.push(`- ${chk.name}: ${chk.rawState}${details}`);
  }

  if (summary.available.length > 0) {
    lines.push("", "Available check contexts:", ...summary.available.map((c) => `- ${c}`));
  }

  return lines.join("\n");
}

export function formatRequiredChecksGuidance(input: RequiredChecksGuidanceInput): string {
  const lines = [
    `Repo: ${input.repo}`,
    `Branch: ${input.branch}`,
    `Required checks: ${input.requiredChecks.join(", ") || "(none)"}`,
    `Missing checks: ${input.missingChecks.join(", ") || "(none)"}`,
    `Available check contexts: ${input.availableChecks.join(", ") || "(none)"}`,
    "Next steps: trigger CI on this branch (push a commit or rerun workflows), or update repos[].requiredChecks (set [] to disable gating).",
  ];

  return lines.join("\n");
}

export function decideBranchProtection(input: {
  requiredChecks: string[];
  availableChecks: string[];
}): BranchProtectionDecision {
  const missingChecks = input.requiredChecks.filter((check) => !input.availableChecks.includes(check));

  if (input.requiredChecks.length === 0) {
    return { kind: "ok", missingChecks: [] };
  }

  if (missingChecks.length > 0) {
    return { kind: "defer", missingChecks };
  }

  return { kind: "ok", missingChecks: [] };
}

export function isMainMergeOverride(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase() === MAIN_MERGE_OVERRIDE_LABEL);
}

export function isMainMergeAllowed(baseBranch: string | null, botBranch: string, labels: string[]): boolean {
  if (!baseBranch) return true;
  if (baseBranch !== "main") return true;
  if (botBranch === "main") return true;
  if (isMainMergeOverride(labels)) return true;
  return false;
}
