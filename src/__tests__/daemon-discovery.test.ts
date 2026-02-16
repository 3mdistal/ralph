import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";

import { classifyDaemonCandidates, discoverDaemon } from "../daemon-discovery";
import { resolveDaemonRecordPath } from "../daemon-record";

function writeRecord(path: string, opts: { daemonId: string; pid: number; startedAt?: string }): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        daemonId: opts.daemonId,
        pid: opts.pid,
        startedAt: opts.startedAt ?? new Date().toISOString(),
        ralphVersion: "test",
        command: ["bun", "src/index.ts"],
        cwd: process.cwd(),
        controlFilePath: "/tmp/control.json",
      },
      null,
      2
    )
  );
}

describe("daemon discovery", () => {
  let priorHome: string | undefined;
  let priorXdg: string | undefined;
  const tempDirs: string[] = [];

  beforeEach(() => {
    priorHome = process.env.HOME;
    priorXdg = process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;

    if (priorXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorXdg;

    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  test("duplicate live records for same daemon identity are allowed", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-discovery-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "ralph-discovery-xdg-"));
    tempDirs.push(home, xdg);
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = xdg;

    writeRecord(resolveDaemonRecordPath(), { daemonId: "d_same", pid: process.pid });
    writeRecord(join(xdg, "ralph", "daemon.json"), { daemonId: "d_same", pid: process.pid });

    const result = discoverDaemon({ healStale: false });
    expect(result.state).toBe("live");
    expect(result.live?.isCanonical).toBe(true);
  });

  test("multiple distinct live daemon identities fail closed as conflict", () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("Failed to start long-lived child process for conflict test.");
    }

    const home = mkdtempSync(join(tmpdir(), "ralph-discovery-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "ralph-discovery-xdg-"));
    tempDirs.push(home, xdg);
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = xdg;

    try {
      writeRecord(resolveDaemonRecordPath(), { daemonId: "d_one", pid: process.pid });
      writeRecord(join(xdg, "ralph", "daemon.json"), { daemonId: "d_two", pid: child.pid });

      const result = discoverDaemon({ healStale: false });
      expect(result.state).toBe("conflict");
      expect(result.candidates[0]?.isCanonical).toBe(true);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  });

  test("stale record is detected and heal renames file", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-discovery-home-"));
    tempDirs.push(home);
    process.env.HOME = home;

    const canonical = resolveDaemonRecordPath();
    writeRecord(canonical, { daemonId: "d_stale", pid: 999_999_991 });

    const before = discoverDaemon({ healStale: false });
    expect(before.state).toBe("stale");

    const after = discoverDaemon({ healStale: true });
    expect(after.state).toBe("stale");
    expect(after.healedPaths.length).toBeGreaterThan(0);
  });

  test("live legacy record is discovered when canonical missing", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-discovery-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "ralph-discovery-xdg-"));
    tempDirs.push(home, xdg);
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = xdg;

    writeRecord(join(xdg, "ralph", "daemon.json"), { daemonId: "d_legacy_live", pid: process.pid });

    const result = discoverDaemon({ healStale: false });
    expect(result.state).toBe("live");
    expect(result.live?.record.daemonId).toBe("d_legacy_live");
  });

  test("classifier returns missing for empty candidate set", () => {
    const classified = classifyDaemonCandidates({ canonicalPath: "/tmp/daemon.json", candidates: [] });
    expect(classified.state).toBe("missing");
    expect(classified.live).toBeNull();
  });

  test("classifier ignores unsafe /tmp candidate when safe managed-legacy candidate is live", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-discovery-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "ralph-discovery-xdg-"));
    tempDirs.push(home, xdg);

    const canonicalPath = join(home, ".ralph", "control", "daemon-registry.json");
    const classified = classifyDaemonCandidates({
      canonicalPath,
      homeDir: home,
      xdgStateHome: xdg,
      candidates: [
        {
          path: join("/tmp", "ralph", "1000", "daemon.json"),
          isCanonical: false,
          alive: true,
          record: {
            version: 1,
            daemonId: "d_tmp",
            pid: 222,
            startedAt: "2026-02-09T00:00:00.000Z",
            heartbeatAt: "2026-02-09T00:00:10.000Z",
            controlRoot: join("/tmp", "ralph", "1000"),
            ralphVersion: "test",
            command: ["bun", "src/index.ts"],
            cwd: process.cwd(),
            controlFilePath: join("/tmp", "ralph", "1000", "control.json"),
          },
        },
        {
          path: join(xdg, "ralph", "daemon.json"),
          isCanonical: false,
          alive: true,
          record: {
            version: 1,
            daemonId: "d_safe",
            pid: 111,
            startedAt: "2026-02-09T00:00:00.000Z",
            heartbeatAt: "2026-02-09T00:00:09.000Z",
            controlRoot: join(home, ".ralph", "control"),
            ralphVersion: "test",
            command: ["bun", "src/index.ts"],
            cwd: process.cwd(),
            controlFilePath: join(home, ".ralph", "control", "control.json"),
          },
        },
      ],
    });

    expect(classified.state).toBe("live");
    expect(classified.live?.record.daemonId).toBe("d_safe");
  });

  test("classifier fails closed when only unsafe /tmp candidates exist", () => {
    const home = mkdtempSync(join(tmpdir(), "ralph-discovery-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "ralph-discovery-xdg-"));
    tempDirs.push(home, xdg);

    const classified = classifyDaemonCandidates({
      canonicalPath: join(home, ".ralph", "control", "daemon-registry.json"),
      homeDir: home,
      xdgStateHome: xdg,
      candidates: [
        {
          path: join("/tmp", "ralph", "1000", "daemon.json"),
          isCanonical: false,
          alive: true,
          record: {
            version: 1,
            daemonId: "d_tmp_only",
            pid: 333,
            startedAt: "2026-02-09T00:00:00.000Z",
            heartbeatAt: "2026-02-09T00:00:10.000Z",
            controlRoot: join("/tmp", "ralph", "1000"),
            ralphVersion: "test",
            command: ["bun", "src/index.ts"],
            cwd: process.cwd(),
            controlFilePath: join("/tmp", "ralph", "1000", "control.json"),
          },
        },
      ],
    });

    expect(classified.state).toBe("missing");
    expect(classified.live).toBeNull();
  });
});
