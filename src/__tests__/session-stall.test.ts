import { describe, expect, test } from "bun:test";

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";

import { runAgent } from "../session";

function createFakeScheduler(startMs = 0) {
  let nowMs = startMs;

  let nextId = 1;
  const timeouts = new Map<number, { at: number; cb: () => void }>();
  const intervals = new Map<number, { every: number; next: number; cb: () => void }>();

  const runDue = () => {
    for (;;) {
      let didWork = false;

      for (const [id, entry] of timeouts) {
        if (entry.at <= nowMs) {
          timeouts.delete(id);
          entry.cb();
          didWork = true;
        }
      }

      for (const entry of intervals.values()) {
        while (entry.next <= nowMs) {
          entry.next += entry.every;
          entry.cb();
          didWork = true;
        }
      }

      if (!didWork) break;
    }
  };

  return {
    now: () => nowMs,
    setTimeout: (cb: (...args: any[]) => void, ms?: number) => {
      const id = nextId++;
      const delay = typeof ms === "number" ? ms : 0;
      timeouts.set(id, { at: nowMs + delay, cb: () => cb() });
      return id as any;
    },
    clearTimeout: (id: any) => {
      timeouts.delete(Number(id));
    },
    setInterval: (cb: (...args: any[]) => void, ms?: number) => {
      const id = nextId++;
      const every = typeof ms === "number" && ms > 0 ? ms : 1;
      intervals.set(id, { every, next: nowMs + every, cb: () => cb() });
      return id as any;
    },
    clearInterval: (id: any) => {
      intervals.delete(Number(id));
    },
    advance: (ms: number) => {
      nowMs += ms;
      runDue();
    },
  };
}

describe("stall detection", () => {
  test("kills a run after idleMs of no stdout/stderr activity", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "ralph-stall-test-"));

    const scheduler = createFakeScheduler(0);
    const proc = new EventEmitter() as any;
    proc.pid = 123;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.on = proc.addListener.bind(proc);

    const killed: Array<{ pid: number; signal: string }> = [];
    const spawn = () => proc;
    const processKill = (pid: number, signal: any) => {
      killed.push({ pid, signal: String(signal) });
      proc.emit("close", 124);
      return true as any;
    };

    const promise = runAgent(
      "/tmp",
      "general",
      "hello",
      {
        watchdog: { enabled: false },
        stall: { enabled: true, idleMs: 1000 },
        timeoutMs: 60_000,
      },
      {
        scheduler: scheduler as any,
        sessionsDir,
        spawn: spawn as any,
        processKill: processKill as any,
      }
    );

    scheduler.advance(1001);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.stallTimeout?.kind).toBe("stall-timeout");
    expect(killed.length).toBeGreaterThan(0);
  });
});
