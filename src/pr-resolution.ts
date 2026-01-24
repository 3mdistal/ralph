export type ResolvedPrCandidate = {
  url: string;
  source: "db" | "gh-search";
  ghCreatedAt?: string;
  ghUpdatedAt?: string;
  dbUpdatedAt?: string;
};

type RankedCandidate = ResolvedPrCandidate & {
  hasGhCreatedAt: boolean;
  ghCreatedAtMs: number;
  ghUpdatedAtMs: number;
  dbUpdatedAtMs: number;
};

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rankCandidate(candidate: ResolvedPrCandidate): RankedCandidate {
  return {
    ...candidate,
    hasGhCreatedAt: Boolean(candidate.ghCreatedAt),
    ghCreatedAtMs: toTimestamp(candidate.ghCreatedAt),
    ghUpdatedAtMs: toTimestamp(candidate.ghUpdatedAt),
    dbUpdatedAtMs: toTimestamp(candidate.dbUpdatedAt),
  };
}

function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (a.hasGhCreatedAt !== b.hasGhCreatedAt) {
    return a.hasGhCreatedAt ? -1 : 1;
  }

  if (a.ghCreatedAtMs !== b.ghCreatedAtMs) {
    return b.ghCreatedAtMs - a.ghCreatedAtMs;
  }

  if (a.ghUpdatedAtMs !== b.ghUpdatedAtMs) {
    return b.ghUpdatedAtMs - a.ghUpdatedAtMs;
  }

  if (a.dbUpdatedAtMs !== b.dbUpdatedAtMs) {
    return b.dbUpdatedAtMs - a.dbUpdatedAtMs;
  }

  return a.url.localeCompare(b.url);
}

export function selectCanonicalPr(candidates: ResolvedPrCandidate[]): {
  selected: ResolvedPrCandidate | null;
  duplicates: ResolvedPrCandidate[];
} {
  if (candidates.length === 0) return { selected: null, duplicates: [] };
  const ranked = candidates.map(rankCandidate).sort(compareCandidates);
  const [selected, ...rest] = ranked;
  return {
    selected,
    duplicates: rest,
  };
}
