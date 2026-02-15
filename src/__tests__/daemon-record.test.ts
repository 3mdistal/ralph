import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import {
  acquireDaemonSingletonLock,
  readDaemonRecord,
  resolveDaemonRecordPath,
  resolveDaemonRecordPathCandidates,
  writeDaemonRecord,
} from "../daemon-record";

describe("daemon record", () => {
  let priorXdgStateHome: string | undefined;
  let priorHome: string | undefined;
  const tempDirs: string[] = [];

  beforeEach(() => {
    priorXdgStateHome = process.env.XDG_STATE_HOME;
    priorHome = process.env.HOME;
  });

  afterEach(() => {
    if (priorXdgStateHome !== undefined) process.env.XDG_STATE_HOME = priorXdgStateHome;
    else delete process.env.XDG_STATE_HOME;
    if (priorHome !== undefined) process.env.HOME = priorHome;
    else delete process.env.HOME;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("writes and reads daemon record", () => {
    const base = mkdtempSync(join(tmpdir(), "ralph-daemon-"));
    tempDirs.push(base);
    process.env.XDG_STATE_HOME = base;
    process.env.HOME = base;

    writeDaemonRecord({
      version: 1,
      daemonId: "d_test",
      pid: 1234,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      controlRoot: join(base, ".ralph", "control"),
      ralphVersion: "0.1.0",
      command: ["bun", "src/index.ts"],
      cwd: "/tmp",
      controlFilePath: "/tmp/control.json",
    });

    const record = readDaemonRecord();
    expect(record?.daemonId).toBe("d_test");
    expect(record?.pid).toBe(1234);
    expect(record?.command).toEqual(["bun", "src/index.ts"]);
  });

  test("returns null for invalid record", () => {
    const base = mkdtempSync(join(tmpdir(), "ralph-daemon-"));
    tempDirs.push(base);
    process.env.XDG_STATE_HOME = base;
    process.env.HOME = base;

    const recordPath = resolveDaemonRecordPath();
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, "{invalid json");
    const record = readDaemonRecord();
    expect(record).toBeNull();
  });

  test("prefers canonical path under ~/.ralph/control", () => {
    const xdg = mkdtempSync(join(tmpdir(), "ralph-daemon-xdg-"));
    const home = mkdtempSync(join(tmpdir(), "ralph-daemon-home-"));
    tempDirs.push(xdg, home);

    process.env.XDG_STATE_HOME = xdg;
    process.env.HOME = home;

    writeDaemonRecord(
      {
        version: 1,
        daemonId: "d_home",
        pid: 1234,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        controlRoot: join(home, ".ralph", "control"),
        ralphVersion: "0.1.0",
        command: ["bun", "src/index.ts"],
        cwd: "/tmp",
        controlFilePath: "/tmp/control.json",
      },
      { homeDir: home, xdgStateHome: "" }
    );

    const record = readDaemonRecord();
    expect(record?.daemonId).toBe("d_home");
    const recordPath = resolveDaemonRecordPath();
    expect(recordPath).toBe(join(home, ".ralph", "control", "daemon-registry.json"));
    expect(resolveDaemonRecordPathCandidates()[0]).toBe(recordPath);
  });

  test("resolveDaemonRecordPath ignores XDG_STATE_HOME when HOME is set", () => {
    const xdg = mkdtempSync(join(tmpdir(), "ralph-daemon-xdg-"));
    const home = mkdtempSync(join(tmpdir(), "ralph-daemon-home-"));
    tempDirs.push(xdg, home);

    process.env.XDG_STATE_HOME = xdg;
    process.env.HOME = home;

    expect(resolveDaemonRecordPath()).toBe(join(home, ".ralph", "control", "daemon-registry.json"));
    expect(resolveDaemonRecordPathCandidates()[0]).toBe(join(home, ".ralph", "control", "daemon-registry.json"));
    expect(resolveDaemonRecordPathCandidates()).toContain(join(xdg, "ralph", "daemon.json"));
  });

  test("acquireDaemonSingletonLock rejects second live owner", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-daemon-home-"));
    tempDirs.push(home);

    const lockA = acquireDaemonSingletonLock({
      daemonId: "d_one",
      startedAt: "2026-02-08T00:00:00.000Z",
      homeDir: home,
    });

    expect(() =>
      acquireDaemonSingletonLock({
        daemonId: "d_two",
        startedAt: "2026-02-08T00:01:00.000Z",
        homeDir: home,
      })
    ).toThrow("Another daemon already owns");

    lockA.release();
    expect(existsSync(lockA.path)).toBeFalse();
  });

  test("acquireDaemonSingletonLock reclaims stale owner pid", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-daemon-home-"));
    tempDirs.push(home);

    const lockPath = join(home, ".ralph", "control", "daemon.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          daemonId: "d_stale",
          pid: 999_999_991,
          startedAt: "2026-02-08T00:00:00.000Z",
          acquiredAt: "2026-02-08T00:00:00.000Z",
          token: "stale-token",
        },
        null,
        2
      )}\n`
    );

    const lock = acquireDaemonSingletonLock({
      daemonId: "d_new",
      startedAt: "2026-02-08T00:01:00.000Z",
      homeDir: home,
    });

    const current = JSON.parse(readFileSync(lockPath, "utf8")) as { daemonId: string; pid: number };
    expect(current.daemonId).toBe("d_new");
    expect(current.pid).toBe(process.pid);

    lock.release();
    expect(existsSync(lockPath)).toBeFalse();
  });
});
