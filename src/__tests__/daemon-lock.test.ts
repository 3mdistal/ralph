import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { acquireDaemonStartupLock } from "../daemon-lock";
import { resolveDaemonLockDirPath, resolveDaemonLockOwnerPath } from "../control-plane-paths";

function ok(value: string): { status: "ok"; value: string } {
  return { status: "ok", value };
}

function unavailable(): { status: "unavailable" } {
  return { status: "unavailable" };
}

function makeKill(alive: Set<number>): typeof process.kill {
  return ((pid: number, signal?: string | number) => {
    if (signal === 0) {
      if (alive.has(pid)) return true;
      const err: NodeJS.ErrnoException = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    }
    return true;
  }) as typeof process.kill;
}

describe("daemon startup lock", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "ralph-daemon-lock-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("blocks second daemon when first is healthy", async () => {
    const alive = new Set<number>([101]);
    const readStartIdentity = (pid: number) => (pid === 101 ? ok("ticks-101") : ok("ticks-unknown"));
    const readCmdline = () => ok("bun ralph daemon");

    const first = await acquireDaemonStartupLock({
      daemonId: "d_first",
      startedAt: "2026-02-08T00:00:00.000Z",
      homeDir,
      pid: 101,
      processKill: makeKill(alive),
      readStartIdentity,
      readCmdline,
      retryDelayMs: 1,
    });
    expect(first.ok).toBe(true);

    const second = await acquireDaemonStartupLock({
      daemonId: "d_second",
      startedAt: "2026-02-08T00:01:00.000Z",
      homeDir,
      pid: 202,
      processKill: makeKill(alive),
      readStartIdentity,
      readCmdline,
      retryDelayMs: 1,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.exitCode).toBe(2);
      expect(second.message).toContain("pid=101");
      expect(second.message).toContain("ralphctl status");
      expect(second.message).toContain("ralphctl drain");
    }

    if (first.ok) first.lock.release();
  });

  test("recovers stale lock when recorded pid is dead", async () => {
    const aliveFirst = new Set<number>([111]);
    const readStartIdentity = (pid: number) => ok(`ticks-${pid}`);
    const readCmdline = () => ok("bun ralph daemon");

    const first = await acquireDaemonStartupLock({
      daemonId: "d_first",
      startedAt: "2026-02-08T00:00:00.000Z",
      homeDir,
      pid: 111,
      processKill: makeKill(aliveFirst),
      readStartIdentity,
      readCmdline,
      retryDelayMs: 1,
    });
    expect(first.ok).toBe(true);

    const second = await acquireDaemonStartupLock({
      daemonId: "d_second",
      startedAt: "2026-02-08T00:01:00.000Z",
      homeDir,
      pid: 222,
      processKill: makeKill(new Set<number>([222])),
      readStartIdentity,
      readCmdline,
      retryDelayMs: 1,
    });

    expect(second.ok).toBe(true);
    if (second.ok) second.lock.release();
  });

  test("recovers stale lock when pid identity mismatches", async () => {
    const alive = new Set<number>([121, 232]);
    const readCmdline = () => ok("bun ralph daemon");

    const first = await acquireDaemonStartupLock({
      daemonId: "d_first",
      startedAt: "2026-02-08T00:00:00.000Z",
      homeDir,
      pid: 121,
      processKill: makeKill(alive),
      readStartIdentity: () => ok("ticks-first"),
      readCmdline,
      retryDelayMs: 1,
    });
    expect(first.ok).toBe(true);

    const second = await acquireDaemonStartupLock({
      daemonId: "d_second",
      startedAt: "2026-02-08T00:01:00.000Z",
      homeDir,
      pid: 232,
      processKill: makeKill(alive),
      readStartIdentity: (pid: number) => (pid === 121 ? ok("ticks-reused") : ok("ticks-second")),
      readCmdline,
      retryDelayMs: 1,
    });

    expect(second.ok).toBe(true);
    if (second.ok) second.lock.release();
  });

  test("ambiguous liveness refuses and preserves lock", async () => {
    const alive = new Set<number>([131]);
    const readCmdline = () => ok("bun ralph daemon");

    const first = await acquireDaemonStartupLock({
      daemonId: "d_first",
      startedAt: "2026-02-08T00:00:00.000Z",
      homeDir,
      pid: 131,
      processKill: makeKill(alive),
      readStartIdentity: () => ok("ticks-first"),
      readCmdline,
      retryDelayMs: 1,
    });
    expect(first.ok).toBe(true);

    const ownerPath = resolveDaemonLockOwnerPath({ homeDir });
    const lockPath = resolveDaemonLockDirPath({ homeDir });
    const before = readFileSync(ownerPath, "utf8");

    const second = await acquireDaemonStartupLock({
      daemonId: "d_second",
      startedAt: "2026-02-08T00:01:00.000Z",
      homeDir,
      pid: 242,
      processKill: makeKill(alive),
      readStartIdentity: () => unavailable(),
      readCmdline,
      retryDelayMs: 1,
    });

    expect(second.ok).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(ownerPath, "utf8")).toBe(before);

    if (first.ok) first.lock.release();
  });

  test("retries when lock exists before owner file appears", async () => {
    const lockPath = resolveDaemonLockDirPath({ homeDir });
    const ownerPath = resolveDaemonLockOwnerPath({ homeDir });
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath, { recursive: false });

    const second = await acquireDaemonStartupLock({
      daemonId: "d_second",
      startedAt: "2026-02-08T00:01:00.000Z",
      homeDir,
      pid: 252,
      processKill: makeKill(new Set<number>()),
      readStartIdentity: () => ok("ticks-second"),
      readCmdline: () => ok("bun ralph daemon"),
      retryDelayMs: 1,
    });

    expect(second.ok).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(ownerPath)).toBe(false);

    rmSync(lockPath, { recursive: true, force: true });
  });
});
