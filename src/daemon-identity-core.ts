export type DaemonIdentityRecord = {
  daemonId: string;
  pid: number;
  startedAt: string;
};

export type DaemonIdentityCandidate = {
  path: string;
  isCanonical: boolean;
  alive: boolean;
  record: DaemonIdentityRecord;
};

export type DaemonIdentityGroup<T extends DaemonIdentityCandidate> = {
  key: string;
  representative: T;
  candidates: T[];
};

export type DaemonIdentityAnalysis<T extends DaemonIdentityCandidate> = {
  liveCandidates: T[];
  groups: DaemonIdentityGroup<T>[];
  duplicateGroups: DaemonIdentityGroup<T>[];
  distinctLiveIdentities: number;
  hasConflict: boolean;
  primaryLiveCandidate: T | null;
};

export function buildDaemonIdentityKey(input: { daemonId: string; pid: number }): string {
  return `${input.daemonId}:${input.pid}`;
}

function compareByPreference<T extends DaemonIdentityCandidate>(a: T, b: T): number {
  if (a.isCanonical && !b.isCanonical) return -1;
  if (!a.isCanonical && b.isCanonical) return 1;

  const aStarted = Date.parse(a.record.startedAt);
  const bStarted = Date.parse(b.record.startedAt);
  if (Number.isFinite(aStarted) && Number.isFinite(bStarted) && aStarted !== bStarted) return bStarted - aStarted;
  if (Number.isFinite(aStarted) && !Number.isFinite(bStarted)) return -1;
  if (!Number.isFinite(aStarted) && Number.isFinite(bStarted)) return 1;
  return a.path.localeCompare(b.path);
}

export function analyzeLiveDaemonCandidates<T extends DaemonIdentityCandidate>(candidates: T[]): DaemonIdentityAnalysis<T> {
  const liveCandidates = candidates.filter((candidate) => candidate.alive);
  const byKey = new Map<string, T[]>();

  for (const candidate of liveCandidates) {
    const key = buildDaemonIdentityKey(candidate.record);
    const group = byKey.get(key);
    if (group) group.push(candidate);
    else byKey.set(key, [candidate]);
  }

  const groups = Array.from(byKey.entries())
    .map(([key, group]) => {
      const sorted = [...group].sort(compareByPreference);
      return {
        key,
        representative: sorted[0] as T,
        candidates: sorted,
      };
    })
    .sort((a, b) => compareByPreference(a.representative, b.representative));

  const distinctLiveIdentities = groups.length;
  const duplicateGroups = groups.filter((group) => group.candidates.length > 1);
  const hasConflict = distinctLiveIdentities > 1;
  const primaryLiveCandidate = distinctLiveIdentities === 1 ? groups[0]?.representative ?? null : null;

  return {
    liveCandidates,
    groups,
    duplicateGroups,
    distinctLiveIdentities,
    hasConflict,
    primaryLiveCandidate,
  };
}
