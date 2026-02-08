import type { MergeConflictAttempt } from "./github/merge-conflict-comment";

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
  code?: "repeat-merge-content" | "repeat-unknown" | "repeat-grace-exhausted" | "attempts-exhausted";
  repeated: boolean;
  attemptsExhausted: boolean;
} {
  const attemptsExhausted = params.attempts.length >= params.maxAttempts;
  const lastAttempt = params.attempts[params.attempts.length - 1];
  const repeated =
    Boolean(params.nextSignature) &&
    lastAttempt?.status === "failed" &&
    Boolean(lastAttempt?.signature) &&
    lastAttempt.signature === params.nextSignature;

  if (attemptsExhausted) {
    return {
      stop: true,
      code: "attempts-exhausted",
      repeated,
      attemptsExhausted: true,
      reason: `Merge conflicts still unresolved after ${params.maxAttempts} attempt(s).`,
    };
  }

  if (repeated) {
    const failureClass = lastAttempt?.failureClass ?? "unknown";

    if (failureClass === "merge-content") {
      return {
        stop: true,
        code: "repeat-merge-content",
        repeated: true,
        attemptsExhausted,
        reason: "Merge conflicts repeat with the same signature after a merge-content failure; stopping automated recovery to prevent a stasis loop.",
      };
    }

    if (failureClass === "unknown") {
      return {
        stop: true,
        code: "repeat-unknown",
        repeated: true,
        attemptsExhausted,
        reason: "Merge conflicts repeat with the same signature after an unclassified failure; stopping automated recovery.",
      };
    }

    let repeatedGraceEligibleFailures = 0;
    for (let i = params.attempts.length - 1; i >= 0; i -= 1) {
      const attempt = params.attempts[i];
      if (attempt.status !== "failed" || attempt.signature !== params.nextSignature) break;
      if (attempt.failureClass === "permission" || attempt.failureClass === "tooling" || attempt.failureClass === "runtime") {
        repeatedGraceEligibleFailures += 1;
      }
    }

    if (repeatedGraceEligibleFailures >= 2) {
      return {
        stop: true,
        code: "repeat-grace-exhausted",
        repeated: true,
        attemptsExhausted,
        reason:
          "Merge conflicts repeat with the same signature after the non-merge-progress grace retry was already used; stopping automated recovery.",
      };
    }

    return {
      stop: false,
      repeated: true,
      attemptsExhausted,
    };
  }

  return { stop: false, repeated: false, attemptsExhausted: false };
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
      const conflictCount = typeof attempt.conflictCount === "number" ? `, ${attempt.conflictCount} files` : "";
      lines.push(
        `- Attempt ${attempt.attempt} (${attempt.status ?? "unknown"}, ${when})${conflictCount}: ${
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
