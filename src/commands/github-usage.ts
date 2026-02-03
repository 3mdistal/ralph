import { createReadStream } from "fs";
import { existsSync, statSync } from "fs";

import { formatDuration } from "../logging";
import { getRalphEventsDayLogPath, getRalphEventsDir } from "../paths";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_REQUEST_ID_SAMPLES = 5;

type StatusCounts = Map<number, number>;
type StringCounts = Map<string, number>;

type EndpointKey = string;

type BackoffAgg = {
  waitEventCount: number;
  setEventCount: number;
  windows: Set<number>;
  firstAtMs: number | null;
  lastAtMs: number | null;
  maxWaitMs: number;
  maxWindowRemainingMs: number;
};

type EndpointAgg = {
  repo: string;
  method: string;
  path: string;

  count: number;
  okCount: number;
  errorCount: number;
  writeCount: number;

  statusCounts: StatusCounts;
  errorCodeCounts: StringCounts;

  rateLimitedCount: number;
  secondaryRateLimitedCount: number;

  totalDurationMs: number;
  maxDurationMs: number;

  firstAtMs: number | null;
  lastAtMs: number | null;

  requestIdSamples: string[];
};

type RepoAgg = {
  repo: string;
  count: number;
  okCount: number;
  errorCount: number;
  writeCount: number;
  rateLimitedCount: number;
  secondaryRateLimitedCount: number;
  statusCounts: StatusCounts;
  errorCodeCounts: StringCounts;
  totalDurationMs: number;
  maxDurationMs: number;
};

export type GithubUsageEndpointRow = {
  repo: string;
  method: string;
  path: string;
  count: number;
  okCount: number;
  errorCount: number;
  writeCount: number;
  rateLimitedCount: number;
  secondaryRateLimitedCount: number;
  avgDurationMs: number | null;
  maxDurationMs: number;
  statusCounts: Record<string, number>;
  errorCodeCounts: Record<string, number>;
  requestIdSamples: string[];
  firstAt: string | null;
  lastAt: string | null;
};

export type GithubUsageRepoRow = {
  repo: string;
  count: number;
  okCount: number;
  errorCount: number;
  writeCount: number;
  rateLimitedCount: number;
  secondaryRateLimitedCount: number;
  avgDurationMs: number | null;
  maxDurationMs: number;
  statusCounts: Record<string, number>;
  errorCodeCounts: Record<string, number>;
};

export type GithubUsageJsonOutput = {
  version: 1;
  computedAt: string;
  range: {
    since: string;
    until: string;
    date?: string;
  };
  eventsDir: string;
  files: Array<{
    day: string;
    path: string;
    missing: boolean;
    byteCount: number | null;
    lineCount: number;
    parseErrorCount: number;
  }>;
  totals: {
    requests: number;
    ok: number;
    errors: number;
    writes: number;
    rateLimited: number;
    secondaryRateLimited: number;
    parseErrors: number;
    statusCounts: Record<string, number>;
    errorCodeCounts: Record<string, number>;
  };
  backoff: {
    firstAt: string | null;
    lastAt: string | null;
    waitEventCount: number;
    setEventCount: number;
    windowCount: number;
    maxWaitMs: number;
    maxWindowRemainingMs: number;
  };
  repos: GithubUsageRepoRow[];
  topEndpoints: GithubUsageEndpointRow[];
  topWriteEndpoints: GithubUsageEndpointRow[];
};

type GithubUsageSummary = GithubUsageJsonOutput;

function incNumberMap<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function mapToObject(map: Map<string, number> | Map<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of map.entries()) {
    out[String(k)] = v;
  }
  return out;
}

function msToIso(ms: number | null): string | null {
  if (ms == null) return null;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function msToUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDayToUtcMs(day: string): number | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function listUtcDaysBetweenInclusive(sinceMs: number, untilMs: number): string[] {
  const startDay = msToUtcDay(sinceMs);
  const endDay = msToUtcDay(untilMs);
  const start = parseDayToUtcMs(startDay);
  const end = parseDayToUtcMs(endDay);
  if (start == null || end == null) return [startDay];
  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    days.push(msToUtcDay(cursor));
  }
  return days;
}

function parseDurationMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  switch (match[2]) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 60 * 60_000;
    default:
      return null;
  }
}

function parseTimestampMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return null;
  return value.trim();
}

function parseLimit(args: string[]): number {
  const raw = getFlagValue(args, "--limit");
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  const floored = Math.floor(n);
  return floored > 0 ? floored : DEFAULT_LIMIT;
}

function normalizeRepo(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s || "(unknown)";
}

function normalizeMethod(value: unknown): string {
  const s = typeof value === "string" ? value.trim().toUpperCase() : "";
  return s || "(unknown)";
}

function normalizePath(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s || "(unknown)";
}

function buildEndpointKey(repo: string, method: string, path: string): EndpointKey {
  return `${repo}\n${method}\n${path}`;
}

function pushRequestIdSample(target: string[], requestId: string | null): void {
  if (!requestId) return;
  if (target.length >= MAX_REQUEST_ID_SAMPLES) return;
  if (target.includes(requestId)) return;
  target.push(requestId);
}

type IngestResult = {
  matched: boolean;
  parseError: boolean;
};

function ingestGithubRequestLine(params: {
  line: string;
  sinceMs: number;
  untilMs: number;
  endpoints: Map<EndpointKey, EndpointAgg>;
  repos: Map<string, RepoAgg>;
  backoff: BackoffAgg;
  totals: {
    requests: number;
    ok: number;
    errors: number;
    writes: number;
    rateLimited: number;
    secondaryRateLimited: number;
    parseErrors: number;
    statusCounts: StatusCounts;
    errorCodeCounts: StringCounts;
  };
}): IngestResult {
  const line = params.line.trim();
  if (!line) return { matched: false, parseError: false };
  if (!line.includes('"type":"github.request"')) return { matched: false, parseError: false };

  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    params.totals.parseErrors += 1;
    return { matched: false, parseError: true };
  }

  if (!event || typeof event !== "object") return { matched: false, parseError: false };
  if (event.type !== "github.request") return { matched: false, parseError: false };

  const tsRaw = typeof event.ts === "string" ? event.ts : "";
  const tsMs = Date.parse(tsRaw);
  if (!Number.isFinite(tsMs)) return { matched: false, parseError: false };
  if (tsMs < params.sinceMs || tsMs > params.untilMs) return { matched: false, parseError: false };

  const repo = normalizeRepo(event.repo);
  const data: any = event.data && typeof event.data === "object" ? event.data : {};

  const method = normalizeMethod(data.method);
  const path = normalizePath(data.path);
  const status = typeof data.status === "number" && Number.isFinite(data.status) ? data.status : -1;
  const ok = data.ok === true;
  const write = data.write === true;
  const durationMs =
    typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? data.durationMs : 0;
  const requestId = typeof data.requestId === "string" && data.requestId.trim() ? data.requestId.trim() : null;

  const rateLimited = data.rateLimited === true;
  const secondaryRateLimited = data.secondaryRateLimited === true;
  const errorCode = typeof data.errorCode === "string" && data.errorCode.trim() ? data.errorCode.trim() : null;

  params.totals.requests += 1;
  if (ok) params.totals.ok += 1;
  else params.totals.errors += 1;
  if (write) params.totals.writes += 1;
  if (rateLimited) params.totals.rateLimited += 1;
  if (secondaryRateLimited) params.totals.secondaryRateLimited += 1;
  if (status >= 0) incNumberMap(params.totals.statusCounts, status);
  if (errorCode) incNumberMap(params.totals.errorCodeCounts, errorCode);

  const backoffWaitMs =
    typeof data.backoffWaitMs === "number" && Number.isFinite(data.backoffWaitMs) ? data.backoffWaitMs : 0;
  const backoffSetUntilTs =
    typeof data.backoffSetUntilTs === "number" && Number.isFinite(data.backoffSetUntilTs) ? data.backoffSetUntilTs : null;

  const isBackoffEvent = backoffWaitMs > 0 || backoffSetUntilTs != null;
  if (isBackoffEvent) {
    if (params.backoff.firstAtMs == null || tsMs < params.backoff.firstAtMs) params.backoff.firstAtMs = tsMs;
    if (params.backoff.lastAtMs == null || tsMs > params.backoff.lastAtMs) params.backoff.lastAtMs = tsMs;
  }
  if (backoffWaitMs > 0) {
    params.backoff.waitEventCount += 1;
    params.backoff.maxWaitMs = Math.max(params.backoff.maxWaitMs, backoffWaitMs);
  }
  if (backoffSetUntilTs != null) {
    params.backoff.setEventCount += 1;
    params.backoff.windows.add(backoffSetUntilTs);
    const remaining = Math.max(0, backoffSetUntilTs - tsMs);
    params.backoff.maxWindowRemainingMs = Math.max(params.backoff.maxWindowRemainingMs, remaining);
  }

  const key = buildEndpointKey(repo, method, path);
  let endpoint = params.endpoints.get(key);
  if (!endpoint) {
    endpoint = {
      repo,
      method,
      path,
      count: 0,
      okCount: 0,
      errorCount: 0,
      writeCount: 0,
      statusCounts: new Map(),
      errorCodeCounts: new Map(),
      rateLimitedCount: 0,
      secondaryRateLimitedCount: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      firstAtMs: null,
      lastAtMs: null,
      requestIdSamples: [],
    };
    params.endpoints.set(key, endpoint);
  }

  endpoint.count += 1;
  if (ok) endpoint.okCount += 1;
  else endpoint.errorCount += 1;
  if (write) endpoint.writeCount += 1;
  if (status >= 0) incNumberMap(endpoint.statusCounts, status);
  if (errorCode) incNumberMap(endpoint.errorCodeCounts, errorCode);
  if (rateLimited) endpoint.rateLimitedCount += 1;
  if (secondaryRateLimited) endpoint.secondaryRateLimitedCount += 1;
  endpoint.totalDurationMs += durationMs;
  endpoint.maxDurationMs = Math.max(endpoint.maxDurationMs, durationMs);
  if (endpoint.firstAtMs == null || tsMs < endpoint.firstAtMs) endpoint.firstAtMs = tsMs;
  if (endpoint.lastAtMs == null || tsMs > endpoint.lastAtMs) endpoint.lastAtMs = tsMs;
  if (!ok || rateLimited || secondaryRateLimited || write) pushRequestIdSample(endpoint.requestIdSamples, requestId);

  let repoAgg = params.repos.get(repo);
  if (!repoAgg) {
    repoAgg = {
      repo,
      count: 0,
      okCount: 0,
      errorCount: 0,
      writeCount: 0,
      rateLimitedCount: 0,
      secondaryRateLimitedCount: 0,
      statusCounts: new Map(),
      errorCodeCounts: new Map(),
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    params.repos.set(repo, repoAgg);
  }

  repoAgg.count += 1;
  if (ok) repoAgg.okCount += 1;
  else repoAgg.errorCount += 1;
  if (write) repoAgg.writeCount += 1;
  if (rateLimited) repoAgg.rateLimitedCount += 1;
  if (secondaryRateLimited) repoAgg.secondaryRateLimitedCount += 1;
  if (status >= 0) incNumberMap(repoAgg.statusCounts, status);
  if (errorCode) incNumberMap(repoAgg.errorCodeCounts, errorCode);
  repoAgg.totalDurationMs += durationMs;
  repoAgg.maxDurationMs = Math.max(repoAgg.maxDurationMs, durationMs);

  return { matched: true, parseError: false };
}

async function streamJsonlFile(params: { path: string; onLine: (line: string) => void }): Promise<{ lineCount: number }> {
  let lineCount = 0;

  if (!existsSync(params.path)) {
    return { lineCount: 0 };
  }

  await new Promise<void>((resolve) => {
    let buffer = "";
    const stream = createReadStream(params.path, { encoding: "utf8" });
    let resolved = false;

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      if (buffer) {
        lineCount += 1;
        try {
          params.onLine(buffer);
        } catch {
          // ignore
        }
      }
      resolve();
    };

    stream.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        lineCount += 1;
        try {
          params.onLine(line);
        } catch {
          // ignore
        }
      }
    });

    stream.on("error", () => finalize());
    stream.on("close", finalize);
    stream.on("end", finalize);
  });

  return { lineCount };
}

export async function collectGithubUsageSummary(opts: {
  eventsDir?: string;
  sinceMs: number;
  untilMs: number;
  date?: string;
  limit: number;
  nowMs?: number;
}): Promise<GithubUsageSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const eventsDir = opts.eventsDir ?? getRalphEventsDir();
  const sinceMs = Math.max(0, Math.floor(opts.sinceMs));
  const untilMs = Math.max(sinceMs, Math.floor(opts.untilMs));
  const days = listUtcDaysBetweenInclusive(sinceMs, untilMs);

  const endpoints = new Map<EndpointKey, EndpointAgg>();
  const repos = new Map<string, RepoAgg>();
  const backoff: BackoffAgg = {
    waitEventCount: 0,
    setEventCount: 0,
    windows: new Set(),
    firstAtMs: null,
    lastAtMs: null,
    maxWaitMs: 0,
    maxWindowRemainingMs: 0,
  };
  const totals = {
    requests: 0,
    ok: 0,
    errors: 0,
    writes: 0,
    rateLimited: 0,
    secondaryRateLimited: 0,
    parseErrors: 0,
    statusCounts: new Map<number, number>(),
    errorCodeCounts: new Map<string, number>(),
  };

  const files: GithubUsageJsonOutput["files"] = [];

  for (const day of days) {
    const path = getRalphEventsDayLogPath(day, eventsDir);
    const missing = !existsSync(path);
    const byteCount = !missing
      ? (() => {
          try {
            return statSync(path).size;
          } catch {
            return null;
          }
        })()
      : null;

    let fileLineCount = 0;
    let fileParseErrors = 0;

    if (!missing) {
      const result = await streamJsonlFile({
        path,
        onLine: (line) => {
          const ingested = ingestGithubRequestLine({
            line,
            sinceMs,
            untilMs,
            endpoints,
            repos,
            backoff,
            totals,
          });
          if (ingested.parseError) fileParseErrors += 1;
        },
      });
      fileLineCount = result.lineCount;
    }

    files.push({
      day,
      path,
      missing,
      byteCount,
      lineCount: fileLineCount,
      parseErrorCount: fileParseErrors,
    });
  }

  const endpointRows: GithubUsageEndpointRow[] = Array.from(endpoints.values()).map((e) => ({
    repo: e.repo,
    method: e.method,
    path: e.path,
    count: e.count,
    okCount: e.okCount,
    errorCount: e.errorCount,
    writeCount: e.writeCount,
    rateLimitedCount: e.rateLimitedCount,
    secondaryRateLimitedCount: e.secondaryRateLimitedCount,
    avgDurationMs: e.count > 0 ? Math.round(e.totalDurationMs / e.count) : null,
    maxDurationMs: e.maxDurationMs,
    statusCounts: mapToObject(e.statusCounts),
    errorCodeCounts: mapToObject(e.errorCodeCounts),
    requestIdSamples: e.requestIdSamples,
    firstAt: msToIso(e.firstAtMs),
    lastAt: msToIso(e.lastAtMs),
  }));

  const byTotal = [...endpointRows].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
    return `${a.repo}|${a.method}|${a.path}`.localeCompare(`${b.repo}|${b.method}|${b.path}`);
  });

  const byWrites = endpointRows
    .filter((e) => e.writeCount > 0)
    .sort((a, b) => {
      if (b.writeCount !== a.writeCount) return b.writeCount - a.writeCount;
      if (b.count !== a.count) return b.count - a.count;
      return `${a.repo}|${a.method}|${a.path}`.localeCompare(`${b.repo}|${b.method}|${b.path}`);
    });

  const repoRows: GithubUsageRepoRow[] = Array.from(repos.values())
    .map((r) => ({
      repo: r.repo,
      count: r.count,
      okCount: r.okCount,
      errorCount: r.errorCount,
      writeCount: r.writeCount,
      rateLimitedCount: r.rateLimitedCount,
      secondaryRateLimitedCount: r.secondaryRateLimitedCount,
      avgDurationMs: r.count > 0 ? Math.round(r.totalDurationMs / r.count) : null,
      maxDurationMs: r.maxDurationMs,
      statusCounts: mapToObject(r.statusCounts),
      errorCodeCounts: mapToObject(r.errorCodeCounts),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
      return a.repo.localeCompare(b.repo);
    });

  return {
    version: 1,
    computedAt: new Date(nowMs).toISOString(),
    range: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      ...(opts.date ? { date: opts.date } : {}),
    },
    eventsDir,
    files,
    totals: {
      requests: totals.requests,
      ok: totals.ok,
      errors: totals.errors,
      writes: totals.writes,
      rateLimited: totals.rateLimited,
      secondaryRateLimited: totals.secondaryRateLimited,
      parseErrors: totals.parseErrors,
      statusCounts: mapToObject(totals.statusCounts),
      errorCodeCounts: mapToObject(totals.errorCodeCounts),
    },
    backoff: {
      firstAt: msToIso(backoff.firstAtMs),
      lastAt: msToIso(backoff.lastAtMs),
      waitEventCount: backoff.waitEventCount,
      setEventCount: backoff.setEventCount,
      windowCount: backoff.windows.size,
      maxWaitMs: backoff.maxWaitMs,
      maxWindowRemainingMs: backoff.maxWindowRemainingMs,
    },
    repos: repoRows,
    topEndpoints: byTotal.slice(0, Math.max(1, opts.limit)),
    topWriteEndpoints: byWrites.slice(0, Math.max(1, opts.limit)),
  };
}

function formatTopEndpoints(rows: GithubUsageEndpointRow[]): string[] {
  if (rows.length === 0) return ["  (none)"];
  const lines: string[] = [];
  let i = 0;
  for (const row of rows) {
    i += 1;
    const duration = row.avgDurationMs != null ? `${row.avgDurationMs}ms avg` : "-";
    const max = `${row.maxDurationMs}ms max`;
    const rl = row.rateLimitedCount > 0 ? ` rateLimited=${row.rateLimitedCount}` : "";
    const srl = row.secondaryRateLimitedCount > 0 ? ` secondary=${row.secondaryRateLimitedCount}` : "";
    const writes = row.writeCount > 0 ? ` writes=${row.writeCount}` : "";

    lines.push(
      `${String(i).padStart(2, "0")}) ${row.repo} ${row.method} ${row.path} count=${row.count} errors=${row.errorCount}${writes}${rl}${srl} (${duration}, ${max})`
    );
    if (row.requestIdSamples.length > 0) {
      lines.push(`    requestIds: ${row.requestIdSamples.join(", ")}`);
    }
  }
  return lines;
}

function formatGithubUsageHuman(summary: GithubUsageSummary): string {
  const filesPresent = summary.files.filter((f) => !f.missing).length;
  const totalBytes = summary.files.reduce((acc, f) => acc + (typeof f.byteCount === "number" ? f.byteCount : 0), 0);
  const maxBackoff = summary.backoff.maxWindowRemainingMs > 0 ? formatDuration(summary.backoff.maxWindowRemainingMs) : "0s";
  const maxWait = summary.backoff.maxWaitMs > 0 ? formatDuration(summary.backoff.maxWaitMs) : "0s";

  const lines: string[] = [];
  lines.push("GitHub usage (github.request)");
  lines.push(`Range: ${summary.range.since} .. ${summary.range.until}${summary.range.date ? ` (date=${summary.range.date})` : ""}`);
  lines.push(`Events dir: ${summary.eventsDir}`);
  lines.push(`Files: ${filesPresent}/${summary.files.length} present (${Math.round((totalBytes / 1024 / 1024) * 10) / 10}MB read)`);
  lines.push(
    `Totals: requests=${summary.totals.requests} ok=${summary.totals.ok} errors=${summary.totals.errors} writes=${summary.totals.writes} rateLimited=${summary.totals.rateLimited} secondary=${summary.totals.secondaryRateLimited} parseErrors=${summary.totals.parseErrors}`
  );
  lines.push(
    `Backoff: windows=${summary.backoff.windowCount} waitEvents=${summary.backoff.waitEventCount} maxWindow=${maxBackoff} maxWait=${maxWait} first=${summary.backoff.firstAt ?? "-"} last=${summary.backoff.lastAt ?? "-"}`
  );
  lines.push("");
  lines.push("Per repo:");
  if (summary.repos.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of summary.repos) {
      lines.push(
        `  ${row.repo}: requests=${row.count} errors=${row.errorCount} writes=${row.writeCount} rateLimited=${row.rateLimitedCount} secondary=${row.secondaryRateLimitedCount}`
      );
    }
  }

  lines.push("");
  lines.push("Top endpoints (by requests):");
  lines.push(...formatTopEndpoints(summary.topEndpoints));

  lines.push("");
  lines.push("Top endpoints (writes only):");
  lines.push(...formatTopEndpoints(summary.topWriteEndpoints));

  return lines.join("\n");
}

export async function runGithubUsageCommand(opts: { args: string[] }): Promise<void> {
  const args = opts.args;
  const json = args.includes("--json");
  const limit = parseLimit(args);

  const eventsDir = getFlagValue(args, "--events-dir") ?? "";
  const date = getFlagValue(args, "--date");

  const nowMs = Date.now();

  let sinceMs: number;
  let untilMs: number;

  if (date) {
    const dayMs = parseDayToUtcMs(date);
    if (dayMs == null) {
      console.error("Usage: ralph github-usage --date YYYY-MM-DD [--json] [--limit N] [--events-dir <path>]");
      process.exit(1);
      return;
    }
    sinceMs = dayMs;
    untilMs = dayMs + DAY_MS - 1;
  } else {
    const untilRaw = getFlagValue(args, "--until");
    untilMs = parseTimestampMs(untilRaw) ?? nowMs;

    const sinceRaw = getFlagValue(args, "--since");
    const absSince = parseTimestampMs(sinceRaw);
    if (absSince != null) {
      sinceMs = absSince;
    } else {
      const dur = parseDurationMs(sinceRaw) ?? DEFAULT_SINCE_MS;
      sinceMs = untilMs - dur;
    }
  }

  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    console.error(
      "Usage: ralph github-usage [--since 24h] [--until <iso|ms>] [--date YYYY-MM-DD] [--json] [--limit N] [--events-dir <path>]"
    );
    process.exit(1);
    return;
  }

  const summary = await collectGithubUsageSummary({
    eventsDir: eventsDir ? eventsDir : undefined,
    sinceMs,
    untilMs,
    date: date ?? undefined,
    limit,
    nowMs,
  });

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
    return;
  }

  console.log(formatGithubUsageHuman(summary));
}
