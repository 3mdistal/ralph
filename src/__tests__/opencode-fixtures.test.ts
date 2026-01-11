import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";

import {
  __resetSchedulerForTests,
  __resetSpawnForTests,
  __setSchedulerForTests,
  __setSpawnForTests,
  runCommand,
} from "../session";
import { extractPrUrlFromSession } from "../routing";
import { computeLiveAnomalyCountFromJsonl } from "../anomaly";

type TimerId = number;

class FakeScheduler {
  private nowMs: number;
  private nextId = 1;
  private timers = new Map<
    TimerId,
    {
      atMs: number;
      everyMs?: number;
      fn: () => void;
      kind: "timeout" | "interval";
    }
  >();

  constructor(startMs: number) {
    this.nowMs = startMs;
  }

  now = () => this.nowMs;

  setTimeout = (fn: (...args: any[]) => void, delayMs = 0, ...args: any[]): any => {
    const id = this.nextId++;
    this.timers.set(id, {
      atMs: this.nowMs + Math.max(0, Number(delayMs) || 0),
      fn: () => fn(...args),
      kind: "timeout",
    });
    return id;
  };

  clearTimeout = (id: any): void => {
    this.timers.delete(Number(id));
  };

  setInterval = (fn: (...args: any[]) => void, everyMs = 0, ...args: any[]): any => {
    const id = this.nextId++;
    const intervalMs = Math.max(0, Number(everyMs) || 0);
    this.timers.set(id, {
      atMs: this.nowMs + intervalMs,
      everyMs: intervalMs,
      fn: () => fn(...args),
      kind: "interval",
    });
    return id;
  };

  clearInterval = (id: any): void => {
    this.timers.delete(Number(id));
  };

  advanceBy(ms: number): void {
    const target = this.nowMs + Math.max(0, ms);

    while (true) {
      let nextId: number | null = null;
      let nextAt = Infinity;

      for (const [id, t] of this.timers.entries()) {
        if (t.atMs <= target && t.atMs < nextAt) {
          nextAt = t.atMs;
          nextId = id;
        }
      }

      if (nextId == null) break;

      const t = this.timers.get(nextId);
      if (!t) continue;

      this.nowMs = t.atMs;

      if (t.kind === "timeout") {
        this.timers.delete(nextId);
        t.fn();
        continue;
      }

      // interval
      const intervalMs = t.everyMs ?? 0;
      t.atMs = t.atMs + intervalMs;
      this.timers.set(nextId, t);
      t.fn();
    }

    this.nowMs = target;
  }
}

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly pid = 4242;

  private closed = false;

  kill(_signal?: any): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", 137);
  }

  close(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code);
  }
}

async function loadFixtureLines(name: string): Promise<string[]> {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode");
  const content = await readFile(join(fixturesDir, name), "utf8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l + "\n");
}

type SpawnOptions = {
  lines: string[];
  scheduler: FakeScheduler;
  closeOnStart?: number;
};

function spawnFromFixture({ lines, scheduler, closeOnStart }: SpawnOptions) {
  return () => {
    const proc = new FakeChildProcess();

    // Schedule emission at t=0 so listeners attach first.
    for (const line of lines) {
      scheduler.setTimeout(() => {
        proc.stdout.emit("data", Buffer.from(line));
      }, 0);
    }

    if (typeof closeOnStart === "number") {
      scheduler.setTimeout(() => proc.close(closeOnStart), 0);
    }

    return proc as any;
  };
}

describe("fixture-driven OpenCode JSON stream harness", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "ralph-sessions-"));
    process.env.RALPH_SESSIONS_DIR = sessionsDir;
  });

  afterEach(async () => {
    delete process.env.RALPH_SESSIONS_DIR;
    __resetSpawnForTests();
    __resetSchedulerForTests();
    await rm(sessionsDir, { recursive: true, force: true });
  });

  test("watchdog-timeout.jsonl: hard timeout sets SessionResult.watchdogTimeout", async () => {
    const scheduler = new FakeScheduler(0);
    __setSchedulerForTests(scheduler as any);

    const lines = await loadFixtureLines("watchdog-timeout.jsonl");
    __setSpawnForTests(spawnFromFixture({ lines, scheduler }) as any);

    const promise = runCommand("/tmp", "next-task", [], {
      watchdog: {
        thresholdsMs: {
          bash: { softMs: 1000, hardMs: 2000 },
        },
      },
    });

    // Flush initial tool-start event.
    scheduler.advanceBy(0);

    // Trip the watchdog hard timeout without sleeping.
    scheduler.advanceBy(2000);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(Boolean(result.watchdogTimeout)).toBe(true);
    expect(result.watchdogTimeout?.toolName).toBe("bash");
    expect(result.output).toContain("Tool call timed out:");
  });

  test("pr-url-structured.jsonl: structured PR URL beats text output", async () => {
    const scheduler = new FakeScheduler(0);
    __setSchedulerForTests(scheduler as any);

    const lines = await loadFixtureLines("pr-url-structured.jsonl");
    __setSpawnForTests(spawnFromFixture({ lines, scheduler, closeOnStart: 0 }) as any);

    const promise = runCommand("/tmp", "next-task", [], {});
    scheduler.advanceBy(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/123");
    expect(extractPrUrlFromSession(result as any)).toBe("https://github.com/owner/repo/pull/123");
  });

  test("anomaly-burst-recent.jsonl: 20 anomalies in 10s triggers recentBurst", async () => {
    const scheduler = new FakeScheduler(100000);
    __setSchedulerForTests(scheduler as any);

    const lines = await loadFixtureLines("anomaly-burst-recent.jsonl");
    __setSpawnForTests(spawnFromFixture({ lines, scheduler, closeOnStart: 0 }) as any);

    const promise = runCommand("/tmp", "next-task", [], {});
    scheduler.advanceBy(0);
    await promise;

    const eventsPath = join(sessionsDir, "ses_anomaly_recent", "events.jsonl");
    const eventsJsonl = await readFile(eventsPath, "utf8");

    const status = computeLiveAnomalyCountFromJsonl(eventsJsonl, scheduler.now());
    expect(status.total).toBe(20);
    expect(status.recentBurst).toBe(true);
  });

  test("anomaly-burst-total.jsonl: total>=50 triggers regardless of recency", async () => {
    const scheduler = new FakeScheduler(100000);
    __setSchedulerForTests(scheduler as any);

    const lines = await loadFixtureLines("anomaly-burst-total.jsonl");
    __setSpawnForTests(spawnFromFixture({ lines, scheduler, closeOnStart: 0 }) as any);

    const promise = runCommand("/tmp", "next-task", [], {});
    scheduler.advanceBy(0);
    await promise;

    const eventsPath = join(sessionsDir, "ses_anomaly_total", "events.jsonl");
    const eventsJsonl = await readFile(eventsPath, "utf8");

    const status = computeLiveAnomalyCountFromJsonl(eventsJsonl, scheduler.now());
    expect(status.total).toBe(50);
    expect(status.recentBurst).toBe(false);
  });
});
