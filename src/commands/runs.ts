import { redactSensitiveText } from "../redaction";
import { parseDurationMs, parseTimestampMs, resolveTimeRange } from "../time-range";
import {
  getRalphRunDetails,
  initStateDb,
  listRalphRunSessionIds,
  listRalphRunSessionIdsByRunIds,
  listRalphRunTracePointers,
  listRalphRunTracePointersByRunIds,
  listRalphRunsTop,
  type RalphRunSummary,
  type RalphRunTopSort,
} from "../state";

const DEFAULT_LIMIT = 20;
const DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

type RunTracePointers = {
  runLogPaths: string[];
  sessionEventPaths: string[];
  sessionIds: string[];
};

type RunsTopJsonOutput = {
  schemaVersion: 1;
  computedAt: string;
  range: {
    since: string | null;
    until: string;
  };
  sort: RalphRunTopSort;
  includeMissing: boolean;
  limit: number;
  runs: Array<{
    runId: string;
    repo: string;
    issueNumber: number | null;
    startedAt: string;
    completedAt: string | null;
    outcome: string | null;
    tokensTotal: number | null;
    tokensComplete: boolean;
    triageScore: number | null;
    triageFlags: string[];
    tracePointers: RunTracePointers;
  }>;
};

type RunsShowJsonOutput = {
  schemaVersion: 1;
  computedAt: string;
  run: RunsTopJsonOutput["runs"][number];
};

function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return null;
  return value.trim();
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseLimit(args: string[]): number {
  const raw = getFlagValue(args, "--limit");
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  const floored = Math.floor(n);
  return floored > 0 ? floored : DEFAULT_LIMIT;
}

function parseSort(args: string[]): RalphRunTopSort | null {
  const raw = getFlagValue(args, "--sort");
  if (!raw) return "tokens_total";
  const normalized = raw.trim();
  if (normalized === "tokens_total" || normalized === "triage_score") return normalized;
  return null;
}

function formatIssueLabel(repo: string, issueNumber: number | null): string {
  const issue = typeof issueNumber === "number" ? `#${issueNumber}` : "#?";
  return `${repo}${issue}`;
}

function formatTokenValue(value: number | null): string {
  return typeof value === "number" ? String(value) : "unknown";
}

function formatTriageValue(value: number | null): string {
  return typeof value === "number" ? String(value) : "unknown";
}

function normalizeTracePointers(params: {
  runId: string;
  tracePointersByRun: Map<string, ReturnType<typeof listRalphRunTracePointers>>;
  sessionIdsByRun: Map<string, string[]>;
}): RunTracePointers {
  const pointers = params.tracePointersByRun.get(params.runId) ?? [];
  const runLogPaths = pointers
    .filter((p) => p.kind === "run_log_path")
    .map((p) => redactSensitiveText(p.path));
  const sessionEventPaths = pointers
    .filter((p) => p.kind === "session_events_path")
    .map((p) => redactSensitiveText(p.path));
  const sessionIds = params.sessionIdsByRun.get(params.runId) ?? [];
  return {
    runLogPaths,
    sessionEventPaths,
    sessionIds,
  };
}

function formatRunTraceLines(trace: RunTracePointers): string[] {
  const lines: string[] = [];
  if (trace.sessionIds.length > 0) {
    lines.push(`  sessions: ${trace.sessionIds.join(", ")}`);
  }
  if (trace.sessionEventPaths.length > 0) {
    lines.push(`  traces: ${trace.sessionEventPaths.join(", ")}`);
  }
  if (trace.runLogPaths.length > 0) {
    lines.push(`  run-logs: ${trace.runLogPaths.join(", ")}`);
  }
  if (lines.length === 0) lines.push("  traces: (none)");
  return lines;
}

function formatRunsTopHuman(rows: Array<{ run: RalphRunSummary; trace: RunTracePointers }>): string {
  if (rows.length === 0) return "No runs matched the query.";

  const header = ["RUN", "ISSUE", "OUTCOME", "ENDED", "TOKENS", "TRIAGE"];
  const widths = [8, 24, 10, 20, 10, 10];
  const fmt = (value: string, width: number) => (value.length >= width ? value.slice(0, width) : value.padEnd(width));
  const lines: string[] = [];

  lines.push(header.map((h, i) => fmt(h, widths[i]!)).join(" "));
  lines.push(widths.map((w) => "-".repeat(w)).join(" "));

  for (const { run, trace } of rows) {
    const runShort = run.runId.slice(0, 8);
    const issueLabel = formatIssueLabel(run.repo, run.issueNumber);
    const outcome = run.outcome ?? "unknown";
    const endedAt = run.completedAt ?? "-";
    const tokens = formatTokenValue(run.tokensTotal);
    const triage = formatTriageValue(run.triageScore);
    const row = [runShort, issueLabel, outcome, endedAt, tokens, triage];
    lines.push(row.map((value, i) => fmt(value, widths[i]!)).join(" "));
    lines.push(...formatRunTraceLines(trace));
  }

  return lines.join("\n");
}

function formatRunShowHuman(run: RalphRunSummary, trace: RunTracePointers): string {
  const lines: string[] = [];
  lines.push(`Run: ${run.runId}`);
  lines.push(`Issue: ${formatIssueLabel(run.repo, run.issueNumber)}`);
  lines.push(`Outcome: ${run.outcome ?? "unknown"}`);
  lines.push(`Started: ${run.startedAt}`);
  lines.push(`Ended: ${run.completedAt ?? "-"}`);
  lines.push(`Tokens total: ${formatTokenValue(run.tokensTotal)}`);
  lines.push(`Triage score: ${formatTriageValue(run.triageScore)}`);
  if (run.triageFlags.length > 0) lines.push(`Triage flags: ${run.triageFlags.join(", ")}`);
  lines.push("Trace pointers:");
  lines.push(...formatRunTraceLines(trace));
  return lines.join("\n");
}

function buildJsonRun(run: RalphRunSummary, trace: RunTracePointers): RunsTopJsonOutput["runs"][number] {
  return {
    runId: run.runId,
    repo: run.repo,
    issueNumber: run.issueNumber,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    outcome: run.outcome ?? null,
    tokensTotal: run.tokensTotal,
    tokensComplete: run.tokensComplete,
    triageScore: run.triageScore,
    triageFlags: run.triageFlags,
    tracePointers: trace,
  };
}

function buildRunsUsage(): string {
  return [
    "Usage:",
    "  ralph runs top [--since 7d] [--until <iso|ms|now>] [--limit N] [--sort tokens_total|triage_score] [--include-missing] [--all] [--json]",
    "  ralph runs show <runId> [--json]",
    "",
    "Notes:",
    "  Default window: --since 7d --until now --limit 20.",
    "  Use --all (or explicit --since) to remove the default window.",
  ].join("\n");
}

export async function runRunsCommand(opts: { args: string[] }): Promise<void> {
  const args = opts.args;
  const subcommand = args[1];
  const json = hasFlag(args, "--json");
  const hasHelp = hasFlag(args, "--help") || hasFlag(args, "-h");

  if (hasHelp || !subcommand) {
    console.log(buildRunsUsage());
    process.exit(subcommand ? 0 : 1);
    return;
  }

  initStateDb();
  const nowMs = Date.now();

  if (subcommand === "top") {
    const sort = parseSort(args);
    if (!sort) {
      console.error(buildRunsUsage());
      process.exit(1);
      return;
    }

    const includeMissing = hasFlag(args, "--include-missing");
    const limit = parseLimit(args);
    const sinceRaw = getFlagValue(args, "--since");
    const untilRaw = getFlagValue(args, "--until");
    const hasSinceFlag = hasFlag(args, "--since");
    const hasUntilFlag = hasFlag(args, "--until");
    const all = hasFlag(args, "--all");

    if ((hasSinceFlag && !sinceRaw) || (hasUntilFlag && !untilRaw)) {
      console.error(buildRunsUsage());
      process.exit(1);
      return;
    }

    if (sinceRaw) {
      const sinceIsAbsolute = parseTimestampMs(sinceRaw, nowMs) != null;
      const sinceIsDuration = parseDurationMs(sinceRaw) != null;
      if (!sinceIsAbsolute && !sinceIsDuration) {
        console.error(buildRunsUsage());
        process.exit(1);
        return;
      }
    }

    if (untilRaw && parseTimestampMs(untilRaw, nowMs) == null) {
      console.error(buildRunsUsage());
      process.exit(1);
      return;
    }

    let sinceMs: number | null;
    let untilMs: number;

    if (all && !sinceRaw) {
      untilMs = parseTimestampMs(untilRaw, nowMs) ?? nowMs;
      sinceMs = null;
    } else {
      const resolved = resolveTimeRange({
        sinceRaw,
        untilRaw,
        defaultSinceMs: DEFAULT_SINCE_MS,
        nowMs,
      });
      sinceMs = resolved.sinceMs;
      untilMs = resolved.untilMs;
    }

    if (sinceMs != null && (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs)) {
      console.error(buildRunsUsage());
      process.exit(1);
      return;
    }

    const sinceIso = sinceMs == null ? null : new Date(sinceMs).toISOString();
    const untilIso = new Date(untilMs).toISOString();

    const runs = listRalphRunsTop({
      limit,
      sort,
      includeMissing,
      sinceIso,
      untilIso,
    });

    const runIds = runs.map((run) => run.runId);
    const tracePointersByRun = listRalphRunTracePointersByRunIds(runIds);
    const sessionIdsByRun = listRalphRunSessionIdsByRunIds(runIds);

    if (json) {
      const output: RunsTopJsonOutput = {
        schemaVersion: 1,
        computedAt: new Date(nowMs).toISOString(),
        range: {
          since: sinceIso,
          until: untilIso,
        },
        sort,
        includeMissing,
        limit,
        runs: runs.map((run) => buildJsonRun(run, normalizeTracePointers({ runId: run.runId, tracePointersByRun, sessionIdsByRun }))),
      };
      console.log(JSON.stringify(output, null, 2));
      process.exit(0);
      return;
    }

    const rows = runs.map((run) => ({
      run,
      trace: normalizeTracePointers({ runId: run.runId, tracePointersByRun, sessionIdsByRun }),
    }));
    console.log(formatRunsTopHuman(rows));
    process.exit(0);
    return;
  }

  if (subcommand === "show") {
    const runId = args[2]?.trim() ?? "";
    if (!runId) {
      console.error(buildRunsUsage());
      process.exit(1);
      return;
    }

    const run = getRalphRunDetails(runId);
    if (!run) {
      console.error(`[ralph] Run not found: ${runId}`);
      process.exit(1);
      return;
    }

    const tracePointers = listRalphRunTracePointers(runId);
    const sessionIds = listRalphRunSessionIds(runId);
    const trace: RunTracePointers = {
      runLogPaths: tracePointers.filter((p) => p.kind === "run_log_path").map((p) => redactSensitiveText(p.path)),
      sessionEventPaths: tracePointers.filter((p) => p.kind === "session_events_path").map((p) => redactSensitiveText(p.path)),
      sessionIds,
    };

    if (json) {
      const output: RunsShowJsonOutput = {
        schemaVersion: 1,
        computedAt: new Date(nowMs).toISOString(),
        run: buildJsonRun(run, trace),
      };
      console.log(JSON.stringify(output, null, 2));
      process.exit(0);
      return;
    }

    console.log(formatRunShowHuman(run, trace));
    process.exit(0);
    return;
  }

  console.error(buildRunsUsage());
  process.exit(1);
}
