import { describe, expect, test } from "bun:test";
import { buildDoctorReport, resolveDoctorExitCode } from "../doctor/core";
import type { DoctorSnapshot } from "../doctor/types";

function snapshotFixture(): DoctorSnapshot {
  return {
    daemonCandidates: [
      {
        path: "/home/test/.ralph/control/daemon-registry.json",
        root: "/home/test/.ralph/control",
        is_canonical: true,
        exists: false,
        state: "missing",
        parse_error: null,
        record: null,
        pid_alive: null,
        identity: null,
      },
      {
        path: "/tmp/ralph/1000/daemon.json",
        root: "/tmp/ralph/1000",
        is_canonical: false,
        exists: true,
        state: "live",
        parse_error: null,
        record: {
          daemonId: "d1",
          pid: process.pid,
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          controlRoot: "/tmp/ralph/1000",
          controlFilePath: "/tmp/ralph/1000/control.json",
          cwd: process.cwd(),
          command: ["bun", "src/index.ts"],
          ralphVersion: "test",
        },
        pid_alive: true,
        identity: { ok: true, reason: null },
      },
    ],
    controlCandidates: [
      {
        path: "/home/test/.ralph/control/control.json",
        root: "/home/test/.ralph/control",
        is_canonical: true,
        exists: true,
        state: "readable",
        parse_error: null,
        control: {
          mode: "running",
          pause_requested: null,
          pause_at_checkpoint: null,
          drain_timeout_ms: null,
        },
      },
      {
        path: "/tmp/ralph/1000/control.json",
        root: "/tmp/ralph/1000",
        is_canonical: false,
        exists: true,
        state: "readable",
        parse_error: null,
        control: {
          mode: "draining",
          pause_requested: true,
          pause_at_checkpoint: "checkpoint",
          drain_timeout_ms: 1000,
        },
      },
    ],
    roots: [
      {
        root: "/home/test/.ralph/control",
        daemon_record_paths: ["/home/test/.ralph/control/daemon-registry.json"],
        daemon_records_present: 0,
        control_file_paths: ["/home/test/.ralph/control/control.json"],
        control_files_present: 1,
      },
      {
        root: "/tmp/ralph/1000",
        daemon_record_paths: ["/tmp/ralph/1000/daemon.json"],
        daemon_records_present: 1,
        control_file_paths: ["/tmp/ralph/1000/control.json"],
        control_files_present: 1,
      },
    ],
  };
}

describe("doctor core", () => {
  test("buildDoctorReport emits findings and recommendations", () => {
    const report = buildDoctorReport({
      snapshot: snapshotFixture(),
      timestamp: "2026-02-08T00:00:00.000Z",
      repairMode: false,
      dryRun: false,
      appliedRepairs: [],
    });

    expect(report.schema_version).toBe(1);
    expect(report.overall_status).toBe("warn");
    expect(report.ok).toBeFalse();
    expect(report.findings.some((finding) => finding.code === "CANONICAL_DAEMON_RECORD_MISSING")).toBeTrue();
    expect(report.findings.some((finding) => finding.code === "LIVE_DAEMON_RECORD_IN_LEGACY_ROOT")).toBeTrue();
    expect(report.findings.some((finding) => finding.code === "CONTROL_FILE_MISMATCH")).toBeTrue();
    expect(report.recommended_repairs.some((item) => item.id === "promote-live-daemon-record-to-canonical")).toBeTrue();
  });

  test("resolveDoctorExitCode follows overall status", () => {
    const home = process.env.HOME?.trim() || "/home/test";
    const okReport = buildDoctorReport({
      snapshot: {
        daemonCandidates: [
          {
            path: `${home}/.ralph/control/daemon-registry.json`,
            root: `${home}/.ralph/control`,
            is_canonical: true,
            exists: true,
            state: "live",
            parse_error: null,
            record: {
              daemonId: "d-ok",
              pid: process.pid,
              startedAt: "2026-02-08T00:00:00.000Z",
              heartbeatAt: "2026-02-08T00:00:01.000Z",
              controlRoot: `${home}/.ralph/control`,
              controlFilePath: `${home}/.ralph/control/control.json`,
              cwd: process.cwd(),
              command: ["bun", "src/index.ts"],
              ralphVersion: "test",
            },
            pid_alive: true,
            identity: { ok: true, reason: null },
          },
        ],
        controlCandidates: [
          {
            path: `${home}/.ralph/control/control.json`,
            root: `${home}/.ralph/control`,
            is_canonical: true,
            exists: true,
            state: "readable",
            parse_error: null,
            control: {
              mode: "running",
              pause_requested: null,
              pause_at_checkpoint: null,
              drain_timeout_ms: null,
            },
          },
        ],
        roots: [],
      },
      timestamp: "2026-02-08T00:00:00.000Z",
      repairMode: false,
      dryRun: false,
      appliedRepairs: [],
    });
    expect(okReport.overall_status).toBe("ok");
    expect(resolveDoctorExitCode(okReport)).toBe(0);

    const warnReport = buildDoctorReport({
      snapshot: snapshotFixture(),
      timestamp: "2026-02-08T00:00:00.000Z",
      repairMode: false,
      dryRun: false,
      appliedRepairs: [],
    });
    expect(resolveDoctorExitCode(warnReport)).toBe(1);
  });

  test("duplicate live records for same identity are warnings, not conflict errors", () => {
    const report = buildDoctorReport({
      snapshot: {
        daemonCandidates: [
          {
            path: "/home/test/.ralph/control/daemon-registry.json",
            root: "/home/test/.ralph/control",
            is_canonical: true,
            exists: true,
            state: "live",
            parse_error: null,
            record: {
              daemonId: "d-dup",
              pid: process.pid,
              startedAt: "2026-02-08T00:00:00.000Z",
              heartbeatAt: "2026-02-08T00:00:01.000Z",
              controlRoot: "/home/test/.ralph/control",
              controlFilePath: "/home/test/.ralph/control/control.json",
              cwd: process.cwd(),
              command: ["bun", "src/index.ts"],
              ralphVersion: "test",
            },
            pid_alive: true,
            identity: { ok: true, reason: null },
          },
          {
            path: "/tmp/ralph/1000/daemon.json",
            root: "/tmp/ralph/1000",
            is_canonical: false,
            exists: true,
            state: "live",
            parse_error: null,
            record: {
              daemonId: "d-dup",
              pid: process.pid,
              startedAt: "2026-02-08T00:00:00.000Z",
              heartbeatAt: "2026-02-08T00:00:01.000Z",
              controlRoot: "/home/test/.ralph/control",
              controlFilePath: "/tmp/ralph/1000/control.json",
              cwd: process.cwd(),
              command: ["bun", "src/index.ts"],
              ralphVersion: "test",
            },
            pid_alive: true,
            identity: { ok: true, reason: null },
          },
        ],
        controlCandidates: [
          {
            path: "/home/test/.ralph/control/control.json",
            root: "/home/test/.ralph/control",
            is_canonical: true,
            exists: true,
            state: "readable",
            parse_error: null,
            control: {
              mode: "running",
              pause_requested: null,
              pause_at_checkpoint: null,
              drain_timeout_ms: null,
            },
          },
          {
            path: "/tmp/ralph/1000/control.json",
            root: "/tmp/ralph/1000",
            is_canonical: false,
            exists: true,
            state: "readable",
            parse_error: null,
            control: {
              mode: "running",
              pause_requested: null,
              pause_at_checkpoint: null,
              drain_timeout_ms: null,
            },
          },
        ],
        roots: [],
      },
      timestamp: "2026-02-08T00:00:00.000Z",
      repairMode: false,
      dryRun: false,
      appliedRepairs: [],
    });

    expect(report.findings.some((finding) => finding.code === "MULTIPLE_LIVE_DAEMON_RECORDS")).toBeFalse();
    expect(report.findings.some((finding) => finding.code === "DUPLICATE_LIVE_DAEMON_RECORDS")).toBeTrue();
    expect(report.recommended_repairs.some((repair) => repair.code === "QUARANTINE_DUPLICATE_DAEMON_RECORDS")).toBeTrue();
  });
});
