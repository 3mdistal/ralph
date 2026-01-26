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

  if (repeated) {
    return {
      stop: true,
      repeated: true,
      attemptsExhausted,
      reason: "Merge conflicts repeat with the same signature; stopping automated recovery.",
    };
  }

  if (attemptsExhausted) {
    return {
      stop: true,
      repeated: false,
      attemptsExhausted: true,
      reason: `Merge conflicts still unresolved after ${params.maxAttempts} attempt(s).`,
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
