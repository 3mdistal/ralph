import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { applyDoctorRepairs } from "../doctor/repair";
import type { DoctorSnapshot } from "../doctor/types";

describe("doctor repair", () => {
  let homeDir = "";
  let xdgDir = "";
  let prevHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_STATE_HOME;
    homeDir = mkdtempSync(join(tmpdir(), "ralph-doctor-home-"));
    xdgDir = mkdtempSync(join(tmpdir(), "ralph-doctor-xdg-"));
    process.env.HOME = homeDir;
    process.env.XDG_STATE_HOME = xdgDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(xdgDir, { recursive: true, force: true });
  });

  test("quarantines stale daemon record with timestamp suffix", () => {
    const stalePath = join(homeDir, ".ralph", "control", "daemon-registry.json");
    mkdirSync(join(homeDir, ".ralph", "control"), { recursive: true });
    writeFileSync(stalePath, "{}\n");

    const snapshot: DoctorSnapshot = {
      daemonCandidates: [
        {
          path: stalePath,
          root: join(homeDir, ".ralph", "control"),
          is_canonical: true,
          exists: true,
          state: "stale",
          parse_error: null,
          record: {
            daemonId: "d-stale",
            pid: 999_999_991,
            startedAt: "2026-01-01T00:00:00.000Z",
            heartbeatAt: "2026-01-01T00:00:00.000Z",
            controlRoot: join(homeDir, ".ralph", "control"),
            controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
            cwd: process.cwd(),
            command: ["bun", "src/index.ts"],
            ralphVersion: "test",
          },
          pid_alive: false,
          identity: null,
        },
      ],
      controlCandidates: [],
      roots: [],
    };

    const applied = applyDoctorRepairs({
      snapshot,
      recommendations: [
        {
          id: "quarantine-stale-daemon-records",
          code: "QUARANTINE_STALE_DAEMON_RECORDS",
          title: "Quarantine stale daemon records",
          description: "",
          risk: "safe",
          applies_by_default: false,
          paths: [stalePath],
        },
      ],
      dryRun: false,
      nowIso: "2026-02-08T20:00:00.000Z",
    });

    expect(applied.some((item) => item.status === "applied")).toBeTrue();
    expect(existsSync(stalePath)).toBeFalse();
    const files = readdirSync(join(homeDir, ".ralph", "control"));
    expect(files.some((file) => file.startsWith("daemon-registry.json.stale-"))).toBeTrue();
  });

  test("promotes live legacy record to canonical path", () => {
    const legacyPath = join(xdgDir, "ralph", "daemon.json");
    mkdirSync(join(xdgDir, "ralph"), { recursive: true });
    writeFileSync(
      legacyPath,
      `${JSON.stringify(
        {
          version: 1,
          daemonId: "legacy-live",
          pid: process.pid,
          startedAt: "2026-02-08T20:00:00.000Z",
          heartbeatAt: "2026-02-08T20:10:00.000Z",
          controlRoot: join(homeDir, ".ralph", "control"),
          controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
          ralphVersion: "test",
          command: ["bun", "src/index.ts"],
          cwd: process.cwd(),
        },
        null,
        2
      )}\n`
    );

    const snapshot: DoctorSnapshot = {
      daemonCandidates: [
        {
          path: join(homeDir, ".ralph", "control", "daemon-registry.json"),
          root: join(homeDir, ".ralph", "control"),
          is_canonical: true,
          exists: false,
          state: "missing",
          parse_error: null,
          record: null,
          pid_alive: null,
          identity: null,
        },
        {
          path: legacyPath,
          root: join(xdgDir, "ralph"),
          is_canonical: false,
          exists: true,
          state: "live",
          parse_error: null,
          record: {
            daemonId: "legacy-live",
            pid: process.pid,
            startedAt: "2026-02-08T20:00:00.000Z",
            heartbeatAt: "2026-02-08T20:10:00.000Z",
            controlRoot: join(homeDir, ".ralph", "control"),
            controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
            cwd: process.cwd(),
            command: ["bun", "src/index.ts"],
            ralphVersion: "test",
          },
          pid_alive: true,
          identity: { ok: true, reason: null },
        },
      ],
      controlCandidates: [],
      roots: [],
    };

    const applied = applyDoctorRepairs({
      snapshot,
      recommendations: [
        {
          id: "promote-live-daemon-record-to-canonical",
          code: "PROMOTE_LIVE_DAEMON_RECORD_TO_CANONICAL",
          title: "Promote live daemon record to canonical path",
          description: "",
          risk: "safe",
          applies_by_default: false,
          paths: [legacyPath],
        },
      ],
      dryRun: false,
      nowIso: "2026-02-08T20:00:00.000Z",
    });

    expect(applied.some((item) => item.status === "applied")).toBeTrue();
    const canonicalPath = join(homeDir, ".ralph", "control", "daemon-registry.json");
    expect(existsSync(canonicalPath)).toBeTrue();
    const canonicalRaw = readFileSync(canonicalPath, "utf8");
    expect(canonicalRaw).toContain("legacy-live");
  });

  test("skips promotion when canonical record already matches live legacy source", () => {
    const canonicalPath = join(homeDir, ".ralph", "control", "daemon-registry.json");
    const legacyPath = join(xdgDir, "ralph", "daemon.json");
    mkdirSync(join(homeDir, ".ralph", "control"), { recursive: true });
    mkdirSync(join(xdgDir, "ralph"), { recursive: true });
    const payload = {
      version: 1,
      daemonId: "legacy-live",
      pid: process.pid,
      startedAt: "2026-02-08T20:00:00.000Z",
      heartbeatAt: "2026-02-08T20:10:00.000Z",
      controlRoot: join(homeDir, ".ralph", "control"),
      controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
      ralphVersion: "test",
      command: ["bun", "src/index.ts"],
      cwd: process.cwd(),
    };
    writeFileSync(canonicalPath, `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(legacyPath, `${JSON.stringify(payload, null, 2)}\n`);

    const snapshot: DoctorSnapshot = {
      daemonCandidates: [
        {
          path: canonicalPath,
          root: join(homeDir, ".ralph", "control"),
          is_canonical: true,
          exists: true,
          state: "stale",
          parse_error: null,
          record: {
            daemonId: "legacy-live",
            pid: process.pid,
            startedAt: "2026-02-08T20:00:00.000Z",
            heartbeatAt: "2026-02-08T20:10:00.000Z",
            controlRoot: join(homeDir, ".ralph", "control"),
            controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
            cwd: process.cwd(),
            command: ["bun", "src/index.ts"],
            ralphVersion: "test",
          },
          pid_alive: false,
          identity: { ok: true, reason: null },
        },
        {
          path: legacyPath,
          root: join(xdgDir, "ralph"),
          is_canonical: false,
          exists: true,
          state: "live",
          parse_error: null,
          record: {
            daemonId: "legacy-live",
            pid: process.pid,
            startedAt: "2026-02-08T20:00:00.000Z",
            heartbeatAt: "2026-02-08T20:10:00.000Z",
            controlRoot: join(homeDir, ".ralph", "control"),
            controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
            cwd: process.cwd(),
            command: ["bun", "src/index.ts"],
            ralphVersion: "test",
          },
          pid_alive: true,
          identity: { ok: true, reason: null },
        },
      ],
      controlCandidates: [],
      roots: [],
    };

    const applied = applyDoctorRepairs({
      snapshot,
      recommendations: [
        {
          id: "promote-live-daemon-record-to-canonical",
          code: "PROMOTE_LIVE_DAEMON_RECORD_TO_CANONICAL",
          title: "Promote live daemon record to canonical path",
          description: "",
          risk: "safe",
          applies_by_default: false,
          paths: [legacyPath, canonicalPath],
        },
      ],
      dryRun: false,
      nowIso: "2026-02-08T20:00:00.000Z",
    });

    expect(applied.some((item) => item.status === "skipped" && item.details.includes("already matches"))).toBeTrue();
  });

  test("skips promotion when canonical record differs", () => {
    const canonicalPath = join(homeDir, ".ralph", "control", "daemon-registry.json");
    const legacyPath = join(xdgDir, "ralph", "daemon.json");
    mkdirSync(join(homeDir, ".ralph", "control"), { recursive: true });
    mkdirSync(join(xdgDir, "ralph"), { recursive: true });
    writeFileSync(
      canonicalPath,
      `${JSON.stringify(
        {
          version: 1,
          daemonId: "canonical-existing",
          pid: process.pid,
          startedAt: "2026-02-08T19:00:00.000Z",
          heartbeatAt: "2026-02-08T19:10:00.000Z",
          controlRoot: join(homeDir, ".ralph", "control"),
          controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
          ralphVersion: "test",
          command: ["bun", "src/index.ts"],
          cwd: process.cwd(),
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      legacyPath,
      `${JSON.stringify(
        {
          version: 1,
          daemonId: "legacy-live",
          pid: process.pid,
          startedAt: "2026-02-08T20:00:00.000Z",
          heartbeatAt: "2026-02-08T20:10:00.000Z",
          controlRoot: join(homeDir, ".ralph", "control"),
          controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
          ralphVersion: "test",
          command: ["bun", "src/index.ts"],
          cwd: process.cwd(),
        },
        null,
        2
      )}\n`
    );

    const snapshot: DoctorSnapshot = {
      daemonCandidates: [
        {
          path: canonicalPath,
          root: join(homeDir, ".ralph", "control"),
          is_canonical: true,
          exists: true,
          state: "stale",
          parse_error: null,
          record: {
            daemonId: "canonical-existing",
            pid: process.pid,
            startedAt: "2026-02-08T19:00:00.000Z",
            heartbeatAt: "2026-02-08T19:10:00.000Z",
            controlRoot: join(homeDir, ".ralph", "control"),
            controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
            cwd: process.cwd(),
            command: ["bun", "src/index.ts"],
            ralphVersion: "test",
          },
          pid_alive: false,
          identity: { ok: true, reason: null },
        },
        {
          path: legacyPath,
          root: join(xdgDir, "ralph"),
          is_canonical: false,
          exists: true,
          state: "live",
          parse_error: null,
          record: {
            daemonId: "legacy-live",
            pid: process.pid,
            startedAt: "2026-02-08T20:00:00.000Z",
            heartbeatAt: "2026-02-08T20:10:00.000Z",
            controlRoot: join(homeDir, ".ralph", "control"),
            controlFilePath: join(homeDir, ".ralph", "control", "control.json"),
            cwd: process.cwd(),
            command: ["bun", "src/index.ts"],
            ralphVersion: "test",
          },
          pid_alive: true,
          identity: { ok: true, reason: null },
        },
      ],
      controlCandidates: [],
      roots: [],
    };

    const applied = applyDoctorRepairs({
      snapshot,
      recommendations: [
        {
          id: "promote-live-daemon-record-to-canonical",
          code: "PROMOTE_LIVE_DAEMON_RECORD_TO_CANONICAL",
          title: "Promote live daemon record to canonical path",
          description: "",
          risk: "safe",
          applies_by_default: false,
          paths: [legacyPath, canonicalPath],
        },
      ],
      dryRun: false,
      nowIso: "2026-02-08T20:00:00.000Z",
    });

    expect(applied.some((item) => item.status === "skipped" && item.details.includes("refusing to overwrite"))).toBeTrue();
  });
});
