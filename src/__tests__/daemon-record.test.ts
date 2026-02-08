import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { readDaemonRecord, resolveDaemonRecordPath, writeDaemonRecord } from "../daemon-record";

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

  test("falls back to legacy ~/.local/state when canonical record is missing", () => {
    const xdg = mkdtempSync(join(tmpdir(), "ralph-daemon-xdg-"));
    const home = mkdtempSync(join(tmpdir(), "ralph-daemon-home-"));
    tempDirs.push(xdg, home);

    process.env.XDG_STATE_HOME = xdg;
    process.env.HOME = home;

    const legacyPath = join(home, ".local", "state", "ralph", "daemon.json");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          daemonId: "d_home",
          pid: 1234,
          startedAt: new Date().toISOString(),
          ralphVersion: "0.1.0",
          command: ["bun", "src/index.ts"],
          cwd: "/tmp",
          controlFilePath: "/tmp/control.json",
        },
        null,
        2
      )
    );

    const record = readDaemonRecord();
    expect(record?.daemonId).toBe("d_home");
  });
});
