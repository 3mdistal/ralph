import { appendFile, mkdir, readdir, unlink } from "fs/promises";
import { join } from "path";

import { type RalphEvent, safeJsonStringifyRalphEvent } from "./events";
import { type RalphEventBus } from "./event-bus";
import { getRalphEventsDayLogPath, getRalphEventsDir } from "../paths";
import { redactSensitiveText } from "../redaction";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

export type DashboardEventPersistence = {
  unsubscribe: () => void;
  flush: (opts?: { timeoutMs?: number }) => Promise<{ flushed: boolean }>;
};

export type DashboardEventPersistenceOptions = {
  bus: RalphEventBus;
  retentionDays: number;
  eventsDir?: string;
  now?: () => number;
  redactor?: (value: string) => string;
  appendLine?: (path: string, line: string) => Promise<void>;
};

export function bucketUtcDay(ts: string, nowMs: number): string {
  const date = new Date(ts);
  const ms = Number.isFinite(date.getTime()) ? date.getTime() : nowMs;
  return new Date(ms).toISOString().slice(0, 10);
}

function parseEventLogFilename(filename: string): string | null {
  const match = /^\d{4}-\d{2}-\d{2}\.jsonl$/.exec(filename);
  if (!match) return null;
  return filename.slice(0, 10);
}

function buildDashboardEventJsonlLine(
  event: RalphEvent,
  redactor: (value: string) => string = redactSensitiveText
): string {
  const json = safeJsonStringifyRalphEvent(event);
  return `${redactor(json)}\n`;
}

export function computeRetentionDeletions(opts: {
  files: string[];
  retentionDays: number;
  nowMs: number;
}): string[] {
  const retentionDays = Number.isFinite(opts.retentionDays)
    ? Math.max(1, Math.floor(opts.retentionDays))
    : 1;
  const today = bucketUtcDay(new Date(opts.nowMs).toISOString(), opts.nowMs);
  const cutoffDay = addDays(today, -(retentionDays - 1));
  const cutoffMs = parseDayToUtcMs(cutoffDay);
  if (!cutoffMs) return [];

  const deletions: string[] = [];
  for (const file of opts.files) {
    const day = parseEventLogFilename(file);
    if (!day) continue;
    const dayMs = parseDayToUtcMs(day);
    if (!dayMs) continue;
    if (dayMs < cutoffMs) deletions.push(file);
  }

  return deletions;
}

export async function cleanupDashboardEventLogs(opts: {
  retentionDays: number;
  eventsDir?: string;
  now?: () => number;
}): Promise<{ deleted: string[] }> {
  const eventsDir = opts.eventsDir ?? getRalphEventsDir();
  const nowMs = (opts.now ?? Date.now)();

  let files: string[] = [];
  try {
    files = await readdir(eventsDir);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[ralph] Failed to read dashboard events dir ${eventsDir}: ${err?.message ?? String(err)}`);
    }
    return { deleted: [] };
  }

  const deletions = computeRetentionDeletions({ files, retentionDays: opts.retentionDays, nowMs });
  const deleted: string[] = [];

  for (const filename of deletions) {
    try {
      await unlink(join(eventsDir, filename));
      deleted.push(filename);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn(`[ralph] Failed to delete dashboard event log ${filename}: ${err?.message ?? String(err)}`);
      }
    }
  }

  return { deleted };
}

export function installDashboardEventPersistence(opts: DashboardEventPersistenceOptions): DashboardEventPersistence {
  const eventsDir = opts.eventsDir ?? getRalphEventsDir();
  const now = opts.now ?? Date.now;
  const redactor = opts.redactor ?? redactSensitiveText;
  const appendLine = opts.appendLine ?? createAppendLine(eventsDir);

  const pending: Array<{ path: string; line: string }> = [];
  let draining = false;
  let closed = false;
  const waiters: Array<() => void> = [];

  const notifyIdle = () => {
    if (draining || pending.length > 0) return;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter();
    }
  };

  const waitForIdle = () =>
    new Promise<void>((resolve) => {
      if (!draining && pending.length === 0) {
        resolve();
        return;
      }
      waiters.push(resolve);
    });

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const next = pending.shift();
        if (!next) continue;
        try {
          await appendLine(next.path, next.line);
        } catch (err: any) {
          console.warn(`[ralph] Failed to persist dashboard event: ${err?.message ?? String(err)}`);
        }
      }
    } finally {
      draining = false;
      notifyIdle();
    }
  };

  const enqueue = (event: RalphEvent) => {
    if (closed) return;
    const day = bucketUtcDay(event.ts, now());
    const path = getRalphEventsDayLogPath(day, eventsDir);
    const line = buildDashboardEventJsonlLine(event, redactor);
    pending.push({ path, line });
    void drain();
  };

  const unsubscribe = opts.bus.subscribe(enqueue);

  const flush = async (flushOpts?: { timeoutMs?: number }) => {
    if (pending.length > 0) void drain();

    const timeoutMs = Math.max(0, Math.floor(flushOpts?.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS));
    const idle = waitForIdle();
    if (timeoutMs === 0) {
      await idle;
      return { flushed: true };
    }

    const timedOut = await Promise.race([
      idle.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
    ]);

    return { flushed: !timedOut };
  };

  return {
    unsubscribe: () => {
      closed = true;
      unsubscribe();
    },
    flush,
  };
}

function createAppendLine(eventsDir: string): (path: string, line: string) => Promise<void> {
  let dirReady = false;

  const ensureDir = async () => {
    if (dirReady) return;
    try {
      await mkdir(eventsDir, { recursive: true });
      dirReady = true;
    } catch (err: any) {
      console.warn(`[ralph] Failed to create dashboard events dir ${eventsDir}: ${err?.message ?? String(err)}`);
    }
  };

  return async (path: string, line: string) => {
    await ensureDir();
    await appendFile(path, line, "utf8");
  };
}

function parseDayToUtcMs(day: string): number | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function addDays(day: string, delta: number): string {
  const ms = parseDayToUtcMs(day);
  if (!ms) return day;
  return new Date(ms + delta * DAY_MS).toISOString().slice(0, 10);
}
