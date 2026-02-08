import type { MergeConflictAttempt } from "./github/merge-conflict-comment";

export type MergeConflictFailureClass = "merge-content" | "permission" | "tooling" | "runtime";
export type MergeConflictStopKind = "loop-protection" | "grace-exhausted" | "attempts-exhausted";

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    seen.add(trimmed);
  }
  return Array.from(seen).sort();
}

export function buildMergeConflictSignature(params: {
  baseSha?: string | null;
  headSha?: string | null;
  conflictPaths: string[];
}): string {
  const baseSha = params.baseSha || "unknown";
  const headSha = params.headSha || "unknown";
  const paths = normalizePaths(params.conflictPaths);
  const payload = JSON.stringify({ baseSha, headSha, paths });
  return hashFNV1a(payload);
}

export function computeMergeConflictDecision(params: {
  attempts: MergeConflictAttempt[];
  maxAttempts: number;
  nextSignature: string;
}): {
  stop: boolean;
  reason?: string;
  stopKind?: MergeConflictStopKind;
  repeated: boolean;
  attemptsExhausted: boolean;
  graceApplied: boolean;
} {
  const attemptsExhausted = params.attempts.length >= params.maxAttempts;
  const lastAttempt = params.attempts[params.attempts.length - 1];
  const repeated =
    Boolean(params.nextSignature) &&
    lastAttempt?.status === "failed" &&
    Boolean(lastAttempt?.signature) &&
    lastAttempt.signature === params.nextSignature;

  const tailFailedWithSignatureCount = (() => {
    let count = 0;
    for (let i = params.attempts.length - 1; i >= 0; i -= 1) {
      const attempt = params.attempts[i];
      if (!attempt || attempt.status !== "failed") break;
      if (!attempt.signature || attempt.signature !== params.nextSignature) break;
      count += 1;
    }
    return count;
  })();

  if (repeated) {
    if (attemptsExhausted) {
      return {
        stop: true,
        stopKind: "attempts-exhausted",
        repeated: true,
        attemptsExhausted: true,
        graceApplied: false,
        reason: `Merge conflicts still unresolved after ${params.maxAttempts} attempt(s).`,
      };
    }

    const lastFailureClass: MergeConflictFailureClass = lastAttempt?.failureClass ?? "merge-content";
    if (lastFailureClass === "merge-content") {
      return {
        stop: true,
        stopKind: "loop-protection",
        repeated: true,
        attemptsExhausted,
        graceApplied: false,
        reason:
          "Stopped: repeated conflict signature (merge stasis loop protection after merge-content failure).",
      };
    }

    if (tailFailedWithSignatureCount <= 1) {
      return {
        stop: false,
        repeated: true,
        attemptsExhausted: false,
        graceApplied: true,
      };
    }

    return {
      stop: true,
      stopKind: "grace-exhausted",
      repeated: true,
      attemptsExhausted,
      graceApplied: false,
      reason:
        "Stopped: repeated conflict signature after grace exhausted (prior failure was non-merge-progress).",
    };
  }

  if (attemptsExhausted) {
    return {
      stop: true,
      stopKind: "attempts-exhausted",
      repeated: false,
      attemptsExhausted: true,
      graceApplied: false,
      reason: `Merge conflicts still unresolved after ${params.maxAttempts} attempt(s).`,
    };
  }

  return { stop: false, repeated: false, attemptsExhausted: false, graceApplied: false };
}

const PERMISSION_PATTERNS: RegExp[] = [
  /permission denied/i,
  /operation not permitted/i,
  /eacces/i,
  /access denied/i,
  /authentication failed/i,
  /not authorized/i,
];

const TOOLING_PATTERNS: RegExp[] = [
  /command not found/i,
  /executable file not found/i,
  /no such file or directory/i,
  /cannot find module/i,
  /module not found/i,
  /tool .* not found/i,
];

const RUNTIME_PATTERNS: RegExp[] = [
  /timed out/i,
  /timeout/i,
  /connection reset/i,
  /connection refused/i,
  /temporar(?:y|ily) unavailable/i,
  /network error/i,
];

export function classifyMergeConflictFailure(params: {
  reason?: string;
  loopTrip?: boolean;
  watchdogTimeout?: boolean;
  waitTimedOut?: boolean;
}): MergeConflictFailureClass {
  if (params.loopTrip || params.watchdogTimeout || params.waitTimedOut) return "runtime";
  const reason = params.reason ?? "";
  if (PERMISSION_PATTERNS.some((pattern) => pattern.test(reason))) return "permission";
  if (TOOLING_PATTERNS.some((pattern) => pattern.test(reason))) return "tooling";
  if (RUNTIME_PATTERNS.some((pattern) => pattern.test(reason))) return "runtime";
  return "merge-content";
}

export function formatMergeConflictPaths(paths: string[], maxCount = 8): { total: number; sample: string[] } {
  const normalized = normalizePaths(paths);
  return {
    total: normalized.length,
    sample: normalized.slice(0, Math.max(0, maxCount)),
  };
}

export function buildMergeConflictCommentLines(params: {
  prUrl: string;
  baseRefName: string | null;
  headRefName: string | null;
  conflictPaths: string[];
  attemptCount: number;
  maxAttempts: number;
  action: string;
  reason?: string;
}): string[] {
  const base = params.baseRefName || "(unknown)";
  const head = params.headRefName || "(unknown)";
  const { total, sample } = formatMergeConflictPaths(params.conflictPaths);
  const lines: string[] = [];

  lines.push("Merge-conflict recovery status");
  lines.push("", `PR: ${params.prUrl}`, `Base: ${base}`, `Head: ${head}`);
  lines.push("", `Conflicting files: ${total}`);
  if (sample.length > 0) {
    lines.push("", "Conflicting file sample:");
    for (const file of sample) {
      lines.push(`- ${file}`);
    }
  }

  if (params.reason) {
    lines.push("", `Reason: ${params.reason}`);
  }

  lines.push("", `Action: ${params.action}`, `Attempts: ${params.attemptCount}/${params.maxAttempts}`);
  return lines;
}

export function buildMergeConflictEscalationDetails(params: {
  prUrl: string;
  baseRefName: string | null;
  headRefName: string | null;
  attempts: MergeConflictAttempt[];
  reason: string;
  botBranch?: string | null;
}): string {
  const baseName = params.baseRefName || params.botBranch || "(unknown)";
  const headName = params.headRefName || "(unknown)";
  const baseForCommand = params.baseRefName || params.botBranch || "<base-branch>";
  const normalizedHead = params.headRefName ? params.headRefName.trim() : "";
  const pushLine = normalizedHead
    ? `git push origin HEAD:${normalizedHead}`
    : "# Resolve head ref name: gh pr view --json headRefName -q .headRefName";

  const lines: string[] = [];
  lines.push("Merge-conflict escalation summary", "", `PR: ${params.prUrl}`, `Base: ${baseName}`, `Head: ${headName}`);
  lines.push("", "Reason:", params.reason);

  const latestWithPaths = [...params.attempts].reverse().find((attempt) => attempt.conflictPaths?.length);
  const conflictSample = formatMergeConflictPaths(latestWithPaths?.conflictPaths ?? []);
  const conflictTotal =
    typeof latestWithPaths?.conflictCount === "number" ? latestWithPaths.conflictCount : conflictSample.total;
  lines.push("", `Conflicting files: ${conflictTotal}`);
  if (conflictSample.sample.length > 0) {
    lines.push("", "Conflicting file sample:");
    for (const file of conflictSample.sample) {
      lines.push(`- ${file}`);
    }
  }

  if (params.attempts.length > 0) {
    lines.push("", "Attempts:");
    for (const attempt of params.attempts) {
      const when = attempt.completedAt || attempt.startedAt;
      const failureClass = attempt.status === "failed" && attempt.failureClass ? `, ${attempt.failureClass}` : "";
      const conflictCount = typeof attempt.conflictCount === "number" ? `, ${attempt.conflictCount} files` : "";
      lines.push(
        `- Attempt ${attempt.attempt} (${attempt.status ?? "unknown"}${failureClass}, ${when})${conflictCount}: ${
          attempt.signature || "(no signature)"
        }`
      );
      if (attempt.conflictPaths && attempt.conflictPaths.length > 0) {
        const attemptSample = formatMergeConflictPaths(attempt.conflictPaths, 8);
        lines.push(...attemptSample.sample.map((file) => `  - ${file}`));
        if (attemptSample.total > attemptSample.sample.length) {
          lines.push(`  - (and ${attemptSample.total - attemptSample.sample.length} more)`);
        }
      }
    }
  }

  lines.push(
    "",
    "Commands (run locally):",
    "```bash",
    "git fetch origin",
    `gh pr checkout ${params.prUrl}`,
    `git merge --no-edit origin/${baseForCommand}`,
    "git status",
    "# Resolve conflicts, then:",
    "git add -A",
    "git commit -m \"Resolve merge conflicts\"",
    pushLine,
    "```",
    "",
    "Notes:",
    "- Do not rebase or force-push this PR branch.",
    "- After pushing, apply `ralph:cmd:queue` to resume."
  );

  return lines.join("\n");
}
