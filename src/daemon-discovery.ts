import { existsSync, renameSync } from "fs";
import { basename, dirname } from "path";
import {
  isPidAlive,
  readDaemonRecordAtPath,
  resolveDaemonRecordPath,
  resolveDaemonRecordPathCandidates,
  type DaemonRecord,
  writeDaemonRecord,
} from "./daemon-record";
import {
  buildAuthorityPolicyContext,
  classifyAuthorityRoot,
  isTrustedAuthorityRootClass,
  recordMatchesCanonicalControl,
} from "./daemon-authority-policy";
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
  homeDir?: string;
  xdgStateHome?: string;
}): Omit<DaemonDiscoveryResult, "healedPaths"> {
  const sorted = [...input.candidates].sort(compareCandidates);
  const authority = buildAuthorityPolicyContext({ homeDir: input.homeDir, xdgStateHome: input.xdgStateHome });
  const trusted = sorted.filter((entry) => {
    const rootClass = classifyAuthorityRoot(dirname(entry.path), authority);
    return isTrustedAuthorityRootClass(rootClass);
  });
  const live = analyzeLiveDaemonCandidates(
    trusted.map((entry) => ({
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

  if (trusted.length === 0) {
    return {
      state: "missing",
      canonicalPath: input.canonicalPath,
      live: null,
      candidates: sorted,
      latestRecord: sorted[0]?.record ?? null,
    };
  }

  return {
    state: "stale",
    canonicalPath: input.canonicalPath,
    live: null,
    candidates: sorted,
    latestRecord: trusted[0]?.record ?? null,
  };
}

function compareCandidates(a: DaemonRecordCandidate, b: DaemonRecordCandidate): number {
  if (a.isCanonical && !b.isCanonical) return -1;
  if (!a.isCanonical && b.isCanonical) return 1;

  const aHeartbeat = Date.parse(a.record.heartbeatAt);
  const bHeartbeat = Date.parse(b.record.heartbeatAt);
  if (Number.isFinite(aHeartbeat) && Number.isFinite(bHeartbeat) && aHeartbeat !== bHeartbeat) return bHeartbeat - aHeartbeat;
  if (Number.isFinite(aHeartbeat) && !Number.isFinite(bHeartbeat)) return -1;
  if (!Number.isFinite(aHeartbeat) && Number.isFinite(bHeartbeat)) return 1;

  const aTs = Date.parse(a.record.startedAt);
  const bTs = Date.parse(b.record.startedAt);
  if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return bTs - aTs;
  if (Number.isFinite(aTs) && !Number.isFinite(bTs)) return -1;
  if (!Number.isFinite(aTs) && Number.isFinite(bTs)) return 1;
  return a.path.localeCompare(b.path);
}

function tryHealStalePath(path: string, nowMs: number): string | null {
  if (!existsSync(path)) return null;
  const target = `${path}.stale-${nowMs}-${process.pid}`;
  try {
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}

function migrateCanonicalRecord(candidate: DaemonRecordCandidate, opts?: { homeDir?: string; xdgStateHome?: string }): void {
  if (candidate.isCanonical) return;
  const authority = buildAuthorityPolicyContext({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });
  const rootClass = classifyAuthorityRoot(dirname(candidate.path), authority);
  if (rootClass !== "managed-legacy") return;
  if (!recordMatchesCanonicalControl(candidate.record, authority)) return;
  try {
    writeDaemonRecord(candidate.record, { writeLegacy: false, homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });
  } catch {
    // best effort
  }
}

export function discoverDaemon(opts?: {
  healStale?: boolean;
  pidAlive?: (pid: number) => boolean;
  nowMs?: number;
  homeDir?: string;
  xdgStateHome?: string;
}): DaemonDiscoveryResult {
  const canonicalPath = resolveDaemonRecordPath(opts);
  const candidates: DaemonRecordCandidate[] = [];
  const pidAlive = opts?.pidAlive ?? isPidAlive;
  const nowMs = opts?.nowMs ?? Date.now();

  for (const path of resolveDaemonRecordPathCandidates(opts)) {
    const record = readDaemonRecordAtPath(path, opts);
    if (!record) continue;
    candidates.push({
      path,
      record,
      alive: pidAlive(record.pid),
      isCanonical: path === canonicalPath,
    });
  }

  const classified = classifyDaemonCandidates({
    canonicalPath,
    candidates,
    homeDir: opts?.homeDir,
    xdgStateHome: opts?.xdgStateHome,
  });
  const healedPaths: string[] = [];

  if (opts?.healStale && classified.state === "live" && classified.live) {
    migrateCanonicalRecord(classified.live, opts);
  }

  if (opts?.healStale && classified.state === "stale") {
    for (const entry of classified.candidates) {
      const healed = tryHealStalePath(entry.path, nowMs);
      if (healed) healedPaths.push(`${basename(entry.path)} -> ${basename(healed)}`);
    }
  }

  return { ...classified, healedPaths };
}
