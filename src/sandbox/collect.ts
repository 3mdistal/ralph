import { basename, join } from "path";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";

import { redactSensitiveText } from "../redaction";
import {
  getRalphEventsDayLogPath,
  getRalphEventsDir,
  getRalphRunArtifactsDir,
  getRalphSandboxManifestPath,
} from "../paths";
import {
  getRalphRunDetails,
  listRalphRunSessionIds,
  listRalphRunTracePointers,
  type RalphRunSummary,
} from "../state";

type ToolTimelineRow = {
  ts: string;
  sessionId: string;
  type: string;
  toolName?: string;
  callId?: string;
  title?: string;
};

export type SandboxTraceBundleResult = {
  runId: string;
  outputDir: string;
  bundleManifestPath: string;
  workerToolTimelinePath: string;
  githubRequestsPath: string;
  runLogCount: number;
  sessionEventsCount: number;
  githubRequestCount: number;
};

export async function collectSandboxTraceBundle(params: {
  runId: string;
  outputDir?: string;
}): Promise<SandboxTraceBundleResult> {
  const runId = String(params.runId ?? "").trim();
  if (!runId) throw new Error("Missing run id.");

  const run = getRalphRunDetails(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const outputDir = params.outputDir?.trim() || join(getRalphRunArtifactsDir(runId), "trace-bundle");
  const rawDir = join(outputDir, "raw");
  const runLogsDir = join(rawDir, "run-logs");
  const sessionEventsDir = join(rawDir, "session-events");
  const timelineDir = join(outputDir, "timeline");
  const githubDir = join(outputDir, "github");

  await mkdir(runLogsDir, { recursive: true });
  await mkdir(sessionEventsDir, { recursive: true });
  await mkdir(timelineDir, { recursive: true });
  await mkdir(githubDir, { recursive: true });

  const pointers = listRalphRunTracePointers(runId);
  const runLogPaths = Array.from(new Set(pointers.filter((p) => p.kind === "run_log_path").map((p) => p.path)));
  const sessionEventPaths = Array.from(
    new Set(pointers.filter((p) => p.kind === "session_events_path").map((p) => p.path))
  );

  let runLogCount = 0;
  for (let idx = 0; idx < runLogPaths.length; idx += 1) {
    const sourcePath = runLogPaths[idx]!;
    if (!existsSync(sourcePath)) continue;
    const content = await readFile(sourcePath, "utf8");
    const targetPath = join(runLogsDir, `${String(idx + 1).padStart(2, "0")}-${safeBaseName(sourcePath)}.log`);
    await writeFile(targetPath, redactSensitiveText(content), "utf8");
    runLogCount += 1;
  }

  const sessionIds = listRalphRunSessionIds(runId);
  const timelineRows: ToolTimelineRow[] = [];
  let sessionEventsCount = 0;

  for (let idx = 0; idx < sessionEventPaths.length; idx += 1) {
    const sourcePath = sessionEventPaths[idx]!;
    if (!existsSync(sourcePath)) continue;
    const content = await readFile(sourcePath, "utf8");
    const targetPath = join(
      sessionEventsDir,
      `${String(idx + 1).padStart(2, "0")}-${safeBaseName(sourcePath)}.jsonl`
    );
    const redacted = redactSensitiveText(content);
    await writeFile(targetPath, redacted, "utf8");
    sessionEventsCount += 1;

    const inferredSessionId = inferSessionIdFromPath(sourcePath);
    for (const line of redacted.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = tryJsonParse(trimmed);
      if (!parsed || typeof parsed !== "object") continue;
      const type = String((parsed as any).type ?? "");
      if (!isTimelineEventType(type)) continue;
      const tsValue = (parsed as any).ts;
      const ts = typeof tsValue === "number" ? new Date(tsValue).toISOString() : new Date().toISOString();
      timelineRows.push({
        ts,
        sessionId: inferredSessionId,
        type,
        toolName: asOptionalString((parsed as any).toolName),
        callId: asOptionalString((parsed as any).callId),
        title: asOptionalString((parsed as any).title),
      });
    }
  }

  const workerToolTimelinePath = join(timelineDir, "worker-tool-timeline.jsonl");
  timelineRows.sort((a, b) => a.ts.localeCompare(b.ts));
  await writeFile(workerToolTimelinePath, timelineRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

  const githubRequestRows = await collectGithubRequestsForRun(runId, run);
  const githubRequestsPath = join(githubDir, "github-requests.jsonl");
  await writeFile(githubRequestsPath, githubRequestRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

  const sandboxManifestPath = getRalphSandboxManifestPath(runId);
  const issueUrl =
    typeof run.issueNumber === "number" ? `https://github.com/${run.repo}/issues/${run.issueNumber}` : null;

  const bundleManifest = {
    schemaVersion: 1,
    runId,
    collectedAt: new Date().toISOString(),
    run: {
      repo: run.repo,
      issueNumber: run.issueNumber,
      issueUrl,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      outcome: run.outcome,
      sessionIds,
    },
    files: {
      workerToolTimelinePath,
      githubRequestsPath,
      rawRunLogsDir: runLogsDir,
      rawSessionEventsDir: sessionEventsDir,
    },
    links: {
      sandboxManifestPath: existsSync(sandboxManifestPath) ? sandboxManifestPath : null,
    },
    counts: {
      runLogs: runLogCount,
      sessionEvents: sessionEventsCount,
      githubRequests: githubRequestRows.length,
      timelineRows: timelineRows.length,
    },
  } as const;

  const bundleManifestPath = join(outputDir, "bundle-manifest.json");
  await writeFile(bundleManifestPath, JSON.stringify(bundleManifest, null, 2) + "\n", "utf8");

  return {
    runId,
    outputDir,
    bundleManifestPath,
    workerToolTimelinePath,
    githubRequestsPath,
    runLogCount,
    sessionEventsCount,
    githubRequestCount: githubRequestRows.length,
  };
}

async function collectGithubRequestsForRun(runId: string, run: RalphRunSummary): Promise<
  Array<{
    ts: string;
    method: string;
    path: string;
    status: number;
    ok: boolean;
    requestId: string | null;
    source: string | null;
  }>
> {
  const rows: Array<{
    ts: string;
    method: string;
    path: string;
    status: number;
    ok: boolean;
    requestId: string | null;
    source: string | null;
  }> = [];

  const eventsDir = getRalphEventsDir();
  const startMs = Date.parse(run.startedAt);
  const endMs = Date.parse(run.completedAt ?? new Date().toISOString());
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return rows;

  const days = listUtcDays(startMs, endMs);
  for (const day of days) {
    const dayPath = getRalphEventsDayLogPath(day, eventsDir);
    if (!existsSync(dayPath)) continue;
    const content = await readFile(dayPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = tryJsonParse(trimmed);
      if (!parsed || typeof parsed !== "object") continue;
      if ((parsed as any).type !== "github.request") continue;
      if ((parsed as any).runId !== runId) continue;
      const data = (parsed as any).data;
      if (!data || typeof data !== "object") continue;

      const method = String((data as any).method ?? "").trim();
      const path = String((data as any).path ?? "").trim();
      const status = Number((data as any).status);
      const ok = Boolean((data as any).ok);
      if (!method || !path || !Number.isFinite(status)) continue;

      rows.push({
        ts: String((parsed as any).ts ?? new Date().toISOString()),
        method,
        path,
        status,
        ok,
        requestId: asOptionalString((data as any).requestId) ?? null,
        source: asOptionalString((data as any).source) ?? null,
      });
    }
  }

  rows.sort((a, b) => a.ts.localeCompare(b.ts));
  return rows;
}

function tryJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function listUtcDays(startMs: number, endMs: number): string[] {
  const days: string[] = [];
  let cursor = floorUtcDayMs(startMs);
  const endDay = floorUtcDayMs(endMs);
  while (cursor <= endDay) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 24 * 60 * 60 * 1000;
  }
  return days;
}

function floorUtcDayMs(ts: number): number {
  const iso = new Date(ts).toISOString().slice(0, 10);
  return Date.parse(`${iso}T00:00:00.000Z`);
}

function inferSessionIdFromPath(path: string): string {
  const parts = path.split(/[\\/]/g).filter(Boolean);
  if (parts.length < 2) return "unknown";
  const maybeSession = parts[parts.length - 2] ?? "unknown";
  return maybeSession.startsWith("ses_") ? maybeSession : "unknown";
}

function safeBaseName(path: string): string {
  const base = basename(path).trim();
  if (!base) return "artifact";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isTimelineEventType(type: string): boolean {
  return (
    type === "run-start" ||
    type === "step-start" ||
    type === "tool-start" ||
    type === "tool-progress" ||
    type === "tool-end" ||
    type === "anomaly" ||
    type === "loop-trip"
  );
}
