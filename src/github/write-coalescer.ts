type CoalescedWriteEntry<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  requestedCount: number;
};

const DEFAULT_COALESCE_WINDOW_MS = 250;
const labelWrites = new Map<string, CoalescedWriteEntry<unknown>>();

function readWindowMs(): number {
  const raw = Number(process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS ?? DEFAULT_COALESCE_WINDOW_MS);
  if (!Number.isFinite(raw)) return DEFAULT_COALESCE_WINDOW_MS;
  return Math.max(0, Math.floor(raw));
}

function emit(repo: string, type: string, data: Record<string, unknown>): void {
  console.log(`[ralph:telemetry:${repo}] ${type} ${JSON.stringify(data)}`);
}

function normalizeLabels(labels: string[]): string[] {
  const set = new Set<string>();
  for (const label of labels) {
    const normalized = String(label ?? "").trim();
    if (!normalized) continue;
    set.add(normalized);
  }
  return [...set].sort();
}

function buildSignature(add: string[], remove: string[]): string {
  const addNorm = normalizeLabels(add);
  const removeNorm = normalizeLabels(remove).filter((label) => !addNorm.includes(label));
  return `a:${addNorm.join(",")}|r:${removeNorm.join(",")}`;
}

export function clearIssueWriteCoalescerForTests(): void {
  for (const entry of labelWrites.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  labelWrites.clear();
}

export function coalesceIssueLabelWrite<T>(params: {
  repo: string;
  issueNumber: number;
  add: string[];
  remove: string[];
  source?: string;
  critical?: boolean;
  run: () => Promise<T>;
}): Promise<T> {
  if (params.critical) {
    return params.run();
  }
  const windowMs = readWindowMs();
  if (windowMs <= 0) {
    return params.run();
  }

  const signature = buildSignature(params.add, params.remove);
  const key = `${params.repo}#${params.issueNumber}:${signature}`;
  const existing = labelWrites.get(key) as CoalescedWriteEntry<T> | undefined;
  if (existing) {
    existing.requestedCount += 1;
    emit(params.repo, "github.write.coalesced", {
      kind: "labels",
      repo: params.repo,
      issueNumber: params.issueNumber,
      mergedRequests: existing.requestedCount,
      addCount: params.add.length,
      removeCount: params.remove.length,
      windowMs,
      source: params.source ?? null,
      reason: "identical",
    });
    return existing.promise;
  }

  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const entry: CoalescedWriteEntry<T> = {
    promise,
    resolve,
    reject,
    timer: null,
    requestedCount: 1,
  };
  labelWrites.set(key, entry as CoalescedWriteEntry<unknown>);

  entry.timer = setTimeout(() => {
    entry.timer = null;
    void params
      .run()
      .then((value) => {
        entry.resolve(value);
      })
      .catch((error) => {
        entry.reject(error);
      })
      .finally(() => {
        labelWrites.delete(key);
      });
  }, windowMs);

  return promise;
}
