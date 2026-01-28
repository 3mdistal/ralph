import { hasFailedTopic } from "./selector";

export type SandboxRetentionPolicy = {
  keepLast: number;
  keepFailedDays: number;
};

export type SandboxRepoInfo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  createdAt: string;
  archived: boolean;
  topics: string[];
};

export type SandboxRetentionDecision = {
  repo: SandboxRepoInfo;
  keep: boolean;
  reason: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimestampMs(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function normalizeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function buildSandboxRetentionPlan(params: {
  repos: SandboxRepoInfo[];
  policy: SandboxRetentionPolicy;
  nowMs?: number;
}): SandboxRetentionDecision[] {
  const nowMs = params.nowMs ?? Date.now();
  const keepLast = normalizeInt(params.policy.keepLast);
  const keepFailedDays = normalizeInt(params.policy.keepFailedDays);

  const sorted = [...params.repos].sort((a, b) => {
    const aMs = parseTimestampMs(a.createdAt) ?? 0;
    const bMs = parseTimestampMs(b.createdAt) ?? 0;
    if (aMs !== bMs) return bMs - aMs;
    return a.fullName.localeCompare(b.fullName);
  });

  const keepLastSet = new Set(sorted.slice(0, keepLast).map((repo) => repo.fullName));

  return sorted.map((repo) => {
    if (keepLastSet.has(repo.fullName)) {
      return { repo, keep: true, reason: "lastN" };
    }

    const createdAtMs = parseTimestampMs(repo.createdAt);
    if (!createdAtMs) {
      return { repo, keep: true, reason: "invalidCreatedAt" };
    }

    if (keepFailedDays > 0 && hasFailedTopic({ topics: repo.topics })) {
      const cutoffMs = nowMs - keepFailedDays * DAY_MS;
      if (createdAtMs >= cutoffMs) {
        return { repo, keep: true, reason: "failedWithinDays" };
      }
    }

    return { repo, keep: false, reason: "expired" };
  });
}
