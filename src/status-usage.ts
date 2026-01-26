import type { ThrottleDecision, ThrottleSnapshot, ThrottleState } from "./throttle";

export type StatusUsageSource = "remoteUsage" | "localLogs";

export type StatusUsageWindow = {
  name: string;
  usedPct: number | null;
  resetAt: string | null;
  usedTokens: number | null;
  softCapTokens: number | null;
  hardCapTokens: number | null;
  resumeAt: string | null;
};

export type StatusUsageRow = {
  profileKey: string;
  resolvedProfile: string | null;
  providerID: string;
  state: ThrottleState;
  resumeAt: string | null;
  source: StatusUsageSource;
  windows: StatusUsageWindow[];
  remoteUsageError: string | null;
  dataQuality: "none" | "unknown" | "known";
};

export type StatusUsageSnapshot = {
  profiles: StatusUsageRow[];
};

const AMBIENT_PROFILE_KEY = "ambient";
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const ERROR_TRUNCATE_MAX = 200;

function formatPct(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
}

function sanitizeError(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= ERROR_TRUNCATE_MAX) return trimmed;
  return trimmed.slice(0, ERROR_TRUNCATE_MAX - 1).trimEnd() + "…";
}

function toIso(ts: number | null | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function resolveUsageSource(snapshot: ThrottleSnapshot): StatusUsageSource {
  if (snapshot.openaiSource === "remoteUsage" && snapshot.remoteUsage) return "remoteUsage";
  return "localLogs";
}

function resolveDataQuality(snapshot: ThrottleSnapshot, source: StatusUsageSource): "none" | "unknown" | "known" {
  if (source === "remoteUsage") return snapshot.remoteUsage ? "known" : "none";

  const hasLogs = snapshot.messagesRootDirExists === true && (snapshot.scannedFiles ?? 0) > 0;
  if (!hasLogs) return "none";
  if (snapshot.newestCountedEventTs != null) return "known";
  return "unknown";
}

function mapRemoteWindow(snapshot: ThrottleSnapshot, name: string): StatusUsageWindow {
  const remote = name === "weekly" ? snapshot.remoteUsage?.weekly : snapshot.remoteUsage?.rolling5h;
  return {
    name,
    usedPct: typeof remote?.usedPct === "number" && Number.isFinite(remote.usedPct) ? remote.usedPct : null,
    resetAt: remote?.resetAt ?? null,
    usedTokens: null,
    softCapTokens: null,
    hardCapTokens: null,
    resumeAt: null,
  };
}

function mapLocalWindow(snapshot: ThrottleSnapshot, name: string): StatusUsageWindow {
  const window = snapshot.windows.find((w) => w.name === name);
  return {
    name,
    usedPct: typeof window?.usedPct === "number" && Number.isFinite(window.usedPct) ? window.usedPct : null,
    resetAt: null,
    usedTokens: typeof window?.usedTokens === "number" ? window.usedTokens : null,
    softCapTokens: typeof window?.softCapTokens === "number" ? window.softCapTokens : null,
    hardCapTokens: typeof window?.hardCapTokens === "number" ? window.hardCapTokens : null,
    resumeAt: toIso(window?.resumeAtTs ?? null),
  };
}

export function buildStatusUsageRow(profileKey: string, decision: ThrottleDecision): StatusUsageRow {
  const snapshot = decision.snapshot;
  const source = resolveUsageSource(snapshot);
  const dataQuality = resolveDataQuality(snapshot, source);
  const windows = source === "remoteUsage"
    ? ["rolling5h", "weekly"].map((name) => mapRemoteWindow(snapshot, name))
    : ["rolling5h", "weekly"].map((name) => mapLocalWindow(snapshot, name));

  const remoteUsageError = source === "remoteUsage" ? null : sanitizeError(snapshot.remoteUsageError ?? null);

  return {
    profileKey,
    resolvedProfile: snapshot.opencodeProfile ?? null,
    providerID: snapshot.providerID,
    state: decision.state,
    resumeAt: snapshot.resumeAt ?? null,
    source,
    windows,
    remoteUsageError,
    dataQuality,
  };
}

function orderProfileKeys(profileNames: string[], activeProfile: string | null): string[] {
  const activeKey = (activeProfile ?? "").trim() || AMBIENT_PROFILE_KEY;
  if (profileNames.length === 0) return [activeKey];
  const set = new Set(profileNames);
  const rest = profileNames.filter((name) => name !== activeKey);
  if (set.has(activeKey)) return [activeKey, ...rest];
  return [activeKey, ...profileNames];
}

function toProfileArgument(profileKey: string): string | null {
  return profileKey === AMBIENT_PROFILE_KEY ? null : profileKey;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms (${label})`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function collectStatusUsageRows(opts: {
  profiles: string[];
  activeProfile: string | null;
  activeDecision?: ThrottleDecision;
  decide: (profileKey: string | null) => Promise<ThrottleDecision>;
  concurrency?: number;
  timeoutMs?: number;
}): Promise<StatusUsageRow[]> {
  const ordered = orderProfileKeys(opts.profiles, opts.activeProfile);
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const rows: StatusUsageRow[] = [];
  let idx = 0;

  const next = async (): Promise<void> => {
    const current = idx;
    idx += 1;
    if (current >= ordered.length) return;

    const profileKey = ordered[current]!;
    try {
      let decision: ThrottleDecision;
      if (opts.activeDecision && profileKey === (opts.activeProfile ?? AMBIENT_PROFILE_KEY)) {
        decision = opts.activeDecision;
      } else {
        decision = await withTimeout(opts.decide(toProfileArgument(profileKey)), timeoutMs, profileKey);
      }
      rows[current] = buildStatusUsageRow(profileKey, decision);
    } catch (error) {
      const message = sanitizeError(error instanceof Error ? error.message : String(error));
      rows[current] = {
        profileKey,
        resolvedProfile: null,
        providerID: "unknown",
        state: "ok",
        resumeAt: null,
        source: "localLogs",
        windows: ["rolling5h", "weekly"].map((name) => ({
          name,
          usedPct: null,
          resetAt: null,
          usedTokens: null,
          softCapTokens: null,
          hardCapTokens: null,
          resumeAt: null,
        })),
        remoteUsageError: message,
        dataQuality: "none",
      };
    }

    await next();
  };

  const workers = Array.from({ length: Math.min(concurrency, ordered.length) }, () => next());
  await Promise.all(workers);
  return rows.filter(Boolean);
}

export function formatStatusUsageSection(rows: StatusUsageRow[]): string[] {
  if (!rows.length) return [];
  const lines: string[] = ["Usage:"];

  for (const row of rows) {
    const parts = [`provider=${row.providerID}`, `source=${row.source}`];
    if (row.state !== "ok") parts.push(`state=${row.state}`);
    if (row.resumeAt) parts.push(`resumeAt=${row.resumeAt}`);
    lines.push(`  - ${row.profileKey} (${parts.join(", ")})`);

    if (row.dataQuality === "none") {
      lines.push("      no data / 0 usage");
      if (row.remoteUsageError) lines.push(`      remoteUsageError=${row.remoteUsageError}`);
      continue;
    }

    if (row.source === "remoteUsage") {
      for (const window of row.windows) {
        const usedPct = formatPct(window.usedPct);
        const resetAt = window.resetAt ?? "unknown";
        lines.push(`      ${window.name}: usedPct=${usedPct} resetAt=${resetAt}`);
      }
    } else {
      for (const window of row.windows) {
        const used = window.usedTokens ?? 0;
        const soft = window.softCapTokens ?? 0;
        const hard = window.hardCapTokens ?? 0;
        lines.push(`      ${window.name}: used=${used}/${soft}/${hard}`);
      }
    }

    if (row.remoteUsageError) lines.push(`      remoteUsageError=${row.remoteUsageError}`);
  }

  return lines;
}
