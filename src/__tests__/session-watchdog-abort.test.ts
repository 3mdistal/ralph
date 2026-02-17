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
      timeouts.set(id, { at: nowMs + (typeof ms === "number" ? ms : 0), cb: () => cb() });
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

function createFakeProcess(pid: number): any {
  const proc = new EventEmitter() as any;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.on = proc.addListener.bind(proc);
  return proc;
}

describe("watchdog abort-first termination", () => {
  test("uses session.abort when available before hard-kill fallback", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "ralph-watchdog-abort-test-"));
    const scheduler = createFakeScheduler(0);
    const proc = createFakeProcess(911);

    const killed: Array<{ pid: number; signal: string }> = [];
    const spawn = () => proc;
    const processKill = (pid: number, signal: any) => {
      killed.push({ pid, signal: String(signal) });
      proc.emit("close", 137);
      return true as any;
    };

    let abortCalls = 0;
    const abortSession = async () => {
      abortCalls += 1;
      proc.emit("close", 130);
      return { ok: true, reason: "/session/ses_test/abort" };
    };

    const promise = runAgent(
      "/tmp",
      "general",
      "hello",
      {
        watchdog: {
          enabled: true,
          thresholdsMs: { bash: { softMs: 500, hardMs: 1000 } },
        },
        timeoutMs: 60_000,
      },
      {
        scheduler: scheduler as any,
        sessionsDir,
        spawn: spawn as any,
        processKill: processKill as any,
        abortSession,
      }
    );

    proc.stdout.emit("data", Buffer.from('{"sessionId":"ses_test","type":"tool_start","tool":{"name":"bash","callId":"c1"}}\n'));
    scheduler.advance(1001);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.watchdogTimeout?.kind).toBe("watchdog-timeout");
    expect(result.watchdogTimeout?.source).toBe("session.abort");
    expect(abortCalls).toBe(1);
    expect(killed.length).toBe(0);
  });

  test("falls back to hard-kill when session.abort fails", async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "ralph-watchdog-fallback-test-"));
    const scheduler = createFakeScheduler(0);
    const proc = createFakeProcess(922);

    const killed: Array<{ pid: number; signal: string }> = [];
    const spawn = () => proc;
    const processKill = (pid: number, signal: any) => {
      killed.push({ pid, signal: String(signal) });
      proc.emit("close", 137);
      return true as any;
    };

    const promise = runAgent(
      "/tmp",
      "general",
      "hello",
      {
        watchdog: {
          enabled: true,
          thresholdsMs: { bash: { softMs: 500, hardMs: 1000 } },
        },
        timeoutMs: 60_000,
      },
      {
        scheduler: scheduler as any,
        sessionsDir,
        spawn: spawn as any,
        processKill: processKill as any,
        abortSession: async () => ({ ok: false, reason: "server-unhealthy" }),
      }
    );

    proc.stdout.emit("data", Buffer.from('{"sessionId":"ses_test","type":"tool_start","tool":{"name":"bash","callId":"c2"}}\n'));
    scheduler.advance(1001);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.watchdogTimeout?.kind).toBe("watchdog-timeout");
    expect(result.watchdogTimeout?.source).toBe("session.abort-failed->kill-fallback");
    expect(result.watchdogTimeout?.abortReason).toBe("server-unhealthy");
    expect(killed.length).toBeGreaterThan(0);
  });
});
