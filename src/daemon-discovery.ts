import { existsSync, renameSync } from "fs";
import { basename } from "path";
import {
  isPidAlive,
  readDaemonRecordAtPath,
  resolveDaemonRecordPath,
  resolveDaemonRecordPathCandidates,
  type DaemonRecord,
  writeDaemonRecord,
} from "./daemon-record";
import { analyzeLiveDaemonCandidates } from "./daemon-identity-core";

export type DaemonDiscoveryState = "live" | "missing" | "stale" | "conflict";

export type DaemonRecordCandidate = {
  path: string;
  record: DaemonRecord;
  alive: boolean;
  isCanonical: boolean;
};

export type DaemonDiscoveryResult = {
  state: DaemonDiscoveryState;
  canonicalPath: string;
  live: DaemonRecordCandidate | null;
  candidates: DaemonRecordCandidate[];
  latestRecord: DaemonRecord | null;
  healedPaths: string[];
};

export function classifyDaemonCandidates(input: {
  canonicalPath: string;
  candidates: DaemonRecordCandidate[];
}): Omit<DaemonDiscoveryResult, "healedPaths"> {
  const sorted = [...input.candidates].sort(compareCandidates);
  const live = analyzeLiveDaemonCandidates(
    sorted.map((entry) => ({
      ...entry,
      isCanonical: entry.isCanonical,
      alive: entry.alive,
      record: entry.record,
    }))
  );

  if (live.hasConflict) {
    return {
      state: "conflict",
      canonicalPath: input.canonicalPath,
      live: null,
      candidates: sorted,
      latestRecord: sorted[0]?.record ?? null,
    };
  }

  if (live.primaryLiveCandidate) {
    return {
      state: "live",
      canonicalPath: input.canonicalPath,
      live: live.primaryLiveCandidate,
      candidates: sorted,
      latestRecord: live.primaryLiveCandidate.record ?? sorted[0]?.record ?? null,
    };
  }

  if (sorted.length === 0) {
    return {
      state: "missing",
      canonicalPath: input.canonicalPath,
      live: null,
      candidates: [],
      latestRecord: null,
    };
  }

  return {
    state: "stale",
    canonicalPath: input.canonicalPath,
    live: null,
    candidates: sorted,
    latestRecord: sorted[0]?.record ?? null,
  };
}

function compareCandidates(a: DaemonRecordCandidate, b: DaemonRecordCandidate): number {
  if (a.isCanonical && !b.isCanonical) return -1;
  if (!a.isCanonical && b.isCanonical) return 1;

  const aTs = Date.parse(a.record.startedAt);
  const bTs = Date.parse(b.record.startedAt);
  if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
  if (Number.isFinite(aTs)) return -1;
  if (Number.isFinite(bTs)) return 1;
  return a.path.localeCompare(b.path);
}

function tryHealStalePath(path: string): string | null {
  if (!existsSync(path)) return null;
  const target = `${path}.stale-${Date.now()}-${process.pid}`;
  try {
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}

function migrateCanonicalRecord(candidate: DaemonRecordCandidate): void {
  if (candidate.isCanonical) return;
  try {
    writeDaemonRecord(candidate.record);
  } catch {
    // best effort
  }
}

export function discoverDaemon(opts?: { healStale?: boolean }): DaemonDiscoveryResult {
  const canonicalPath = resolveDaemonRecordPath();
  const candidates: DaemonRecordCandidate[] = [];

  for (const path of resolveDaemonRecordPathCandidates()) {
    const record = readDaemonRecordAtPath(path);
    if (!record) continue;
    candidates.push({
      path,
      record,
      alive: isPidAlive(record.pid),
      isCanonical: path === canonicalPath,
    });
  }

  const classified = classifyDaemonCandidates({ canonicalPath, candidates });
  const healedPaths: string[] = [];

  if (opts?.healStale && classified.state === "live" && classified.live) {
    migrateCanonicalRecord(classified.live);
  }

  if (opts?.healStale && classified.state === "stale") {
    for (const entry of classified.candidates) {
      const healed = tryHealStalePath(entry.path);
      if (healed) healedPaths.push(`${basename(entry.path)} -> ${basename(healed)}`);
    }
  }

  return { ...classified, healedPaths };
}
