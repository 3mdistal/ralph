export type PriorityRepo = {
  name: string;
  priority: number;
};

export type PrioritySelectorState = {
  version: number;
  fingerprint: string;
  bandRemaining: Record<string, number>;
  bandCursors: Record<string, number>;
};

const PRIORITY_SELECTOR_VERSION = 1;

export function createPrioritySelectorState(): PrioritySelectorState {
  return {
    version: PRIORITY_SELECTOR_VERSION,
    fingerprint: "",
    bandRemaining: {},
    bandCursors: {},
  };
}

function buildFingerprint(repos: PriorityRepo[]): string {
  return repos.map((repo) => `${repo.name}:${repo.priority}`).join("|");
}

function buildBands(repos: PriorityRepo[]): Map<number, string[]> {
  const bands = new Map<number, string[]>();
  for (const repo of repos) {
    const existing = bands.get(repo.priority);
    if (existing) {
      existing.push(repo.name);
    } else {
      bands.set(repo.priority, [repo.name]);
    }
  }
  return bands;
}

function buildBandRemaining(bandOrder: number[]): Record<string, number> {
  const remaining: Record<string, number> = {};
  for (const priority of bandOrder) {
    remaining[String(priority)] = Math.max(1, Math.round(priority));
  }
  return remaining;
}

function ensureState(repos: PriorityRepo[], state: PrioritySelectorState): PrioritySelectorState {
  const fingerprint = buildFingerprint(repos);
  if (state.version !== PRIORITY_SELECTOR_VERSION || state.fingerprint !== fingerprint) {
    return {
      version: PRIORITY_SELECTOR_VERSION,
      fingerprint,
      bandRemaining: buildBandRemaining(Array.from(new Set(repos.map((repo) => repo.priority))).sort((a, b) => b - a)),
      bandCursors: {},
    };
  }
  return state;
}

export function selectNextRepoPriority(
  repos: PriorityRepo[],
  state: PrioritySelectorState
): { selectedRepo?: string; state: PrioritySelectorState } {
  if (repos.length === 0) return { state };

  const bands = buildBands(repos);
  const bandOrder = Array.from(bands.keys()).sort((a, b) => b - a);
  if (bandOrder.length === 0) return { state };

  const seeded = ensureState(repos, state);
  let remaining = { ...seeded.bandRemaining };
  const cursors = { ...seeded.bandCursors };

  const hasRemaining = bandOrder.some((priority) => (remaining[String(priority)] ?? 0) > 0);
  if (!hasRemaining) {
    remaining = buildBandRemaining(bandOrder);
  }

  for (const priority of bandOrder) {
    const bandKey = String(priority);
    const bandRemaining = remaining[bandKey] ?? 0;
    if (bandRemaining <= 0) continue;
    const reposInBand = bands.get(priority);
    if (!reposInBand || reposInBand.length === 0) continue;

    const cursor = cursors[bandKey] ?? 0;
    const index = ((cursor % reposInBand.length) + reposInBand.length) % reposInBand.length;
    const selectedRepo = reposInBand[index];

    cursors[bandKey] = (index + 1) % reposInBand.length;
    remaining[bandKey] = bandRemaining - 1;

    return {
      selectedRepo,
      state: {
        version: PRIORITY_SELECTOR_VERSION,
        fingerprint: seeded.fingerprint,
        bandRemaining: remaining,
        bandCursors: cursors,
      },
    };
  }

  return {
    state: {
      version: PRIORITY_SELECTOR_VERSION,
      fingerprint: seeded.fingerprint,
      bandRemaining: remaining,
      bandCursors: cursors,
    },
  };
}
