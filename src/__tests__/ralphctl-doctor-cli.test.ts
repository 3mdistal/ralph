import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { spawn, spawnSync } from "child_process";

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type DoctorJsonV1 = {
  schema_version: number;
  timestamp: string;
  overall_status: "ok" | "warn" | "error";
  ok: boolean;
  repair_mode: boolean;
  dry_run: boolean;
  daemon_candidates: unknown[];
  control_candidates: unknown[];
  roots: unknown[];
  findings: unknown[];
  recommended_repairs: unknown[];
  applied_repairs: Array<{ status: string }>;
};

const REPO_ROOT = process.cwd();

function buildIsolatedEnv(homeDir: string, xdgStateHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    XDG_STATE_HOME: xdgStateHome,
    // Keep bun / XDG caches out of HOME so these contract tests can
    // assert that ralphctl doctor does not mutate the provided HOME tree.
    XDG_CACHE_HOME: join(xdgStateHome, "cache"),
    XDG_CONFIG_HOME: join(xdgStateHome, "config"),
    BUN_INSTALL: join(xdgStateHome, ".bun"),
    BUN_INSTALL_CACHE_DIR: join(xdgStateHome, ".bun", "install", "cache"),
    RALPH_STATE_DB_PATH: join(homeDir, ".ralph", "state.sqlite"),
    RALPH_SESSIONS_DIR: join(homeDir, ".ralph", "sessions"),
    RALPH_WORKTREES_DIR: join(homeDir, ".ralph", "worktrees"),
  };
}

function runRalphctl(args: string[], env: NodeJS.ProcessEnv): CliResult {
  const child = spawnSync(process.execPath, ["src/ralphctl.ts", ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

function assertDoctorJsonV1(payload: unknown): asserts payload is DoctorJsonV1 {
  expect(payload).toBeObject();
  const report = payload as Record<string, unknown>;
  expect(report.schema_version).toBe(1);
  expect(typeof report.timestamp).toBe("string");
  expect(["ok", "warn", "error"]).toContain(String(report.overall_status));
  expect(typeof report.ok).toBe("boolean");
  expect(typeof report.repair_mode).toBe("boolean");
  expect(typeof report.dry_run).toBe("boolean");
  expect(Array.isArray(report.daemon_candidates)).toBeTrue();
  expect(Array.isArray(report.control_candidates)).toBeTrue();
  expect(Array.isArray(report.roots)).toBeTrue();
  expect(Array.isArray(report.findings)).toBeTrue();
  expect(Array.isArray(report.recommended_repairs)).toBeTrue();
  expect(Array.isArray(report.applied_repairs)).toBeTrue();
}

async function snapshotFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await snapshotFiles(absolute);
      lines.push(...nested);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(absolute, "utf8");
    lines.push(`${relative(root, absolute)}:${content}`);
  }
  return lines.sort();
}

async function createDoctorFixture(opts: {
  staleCanonicalDaemon?: boolean;
  liveCanonicalDaemonPid?: number;
  includeCanonicalControl?: boolean;
}): Promise<{ homeDir: string; xdgStateHome: string; canonicalDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "ralph-doctor-cli-home-"));
  const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-doctor-cli-xdg-"));
  const canonicalDir = join(homeDir, ".ralph", "control");
  await mkdir(canonicalDir, { recursive: true });

  const daemonPath = join(canonicalDir, "daemon-registry.json");
  const controlPath = join(canonicalDir, "control.json");
  const nowIso = "2026-02-08T20:00:00.000Z";

  if (opts.staleCanonicalDaemon) {
    await writeFile(
      daemonPath,
      `${JSON.stringify(
        {
          version: 1,
          daemonId: "stale-daemon",
          pid: 999_999_991,
          startedAt: nowIso,
          heartbeatAt: nowIso,
          controlRoot: canonicalDir,
          controlFilePath: controlPath,
          ralphVersion: "test",
          command: ["bun"],
          cwd: REPO_ROOT,
        },
        null,
        2
      )}\n`
    );
  }

  if (opts.liveCanonicalDaemonPid) {
    await writeFile(
      daemonPath,
      `${JSON.stringify(
        {
          version: 1,
          daemonId: "live-daemon",
          pid: opts.liveCanonicalDaemonPid,
          startedAt: nowIso,
          heartbeatAt: nowIso,
          controlRoot: canonicalDir,
          controlFilePath: controlPath,
          ralphVersion: "test",
          command: ["bun"],
          cwd: REPO_ROOT,
        },
        null,
        2
      )}\n`
    );
  }

  if (opts.includeCanonicalControl) {
    await writeFile(
      controlPath,
      `${JSON.stringify(
        {
          version: 1,
          mode: "running",
          pause_requested: false,
          pause_at_checkpoint: null,
          drain_timeout_ms: null,
        },
        null,
        2
      )}\n`
    );
  }

  return { homeDir, xdgStateHome, canonicalDir };
}

describe("ralphctl doctor CLI contract", () => {
  test("returns exit 0 with required JSON v1 fields for healthy state", async () => {
    const fixture = await createDoctorFixture({
      liveCanonicalDaemonPid: process.pid,
      includeCanonicalControl: true,
    });
    try {
      const result = runRalphctl(["doctor", "--json"], buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome));
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      assertDoctorJsonV1(parsed);
      expect(parsed.overall_status).toBe("ok");
      expect(parsed.ok).toBeTrue();
      expect(result.stderr.trim()).toBe("");
    } finally {
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("returns exit 1 for stale records and reports findings in JSON", async () => {
    const fixture = await createDoctorFixture({ staleCanonicalDaemon: true, includeCanonicalControl: false });
    try {
      const result = runRalphctl(["doctor", "--json"], buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome));
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout.trim());
      assertDoctorJsonV1(parsed);
      expect(parsed.overall_status).toBe("warn");
      const findings = parsed.findings as Array<{ code?: string }>;
      expect(findings.some((finding) => finding.code === "STALE_DAEMON_RECORD")).toBeTrue();
      expect(findings.some((finding) => finding.code === "CANONICAL_CONTROL_FILE_MISSING")).toBeTrue();
    } finally {
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("duplicate live records for same identity report warning without conflict error", async () => {
    const fixture = await createDoctorFixture({ liveCanonicalDaemonPid: process.pid, includeCanonicalControl: true });
    try {
      const legacyDir = join(fixture.xdgStateHome, "ralph");
      await mkdir(legacyDir, { recursive: true });
      const legacyDaemonPath = join(legacyDir, "daemon.json");
      const nowIso = "2026-02-08T20:00:00.000Z";
      await writeFile(
        legacyDaemonPath,
        `${JSON.stringify(
          {
            version: 1,
            daemonId: "live-daemon",
            pid: process.pid,
            startedAt: nowIso,
            heartbeatAt: nowIso,
            controlRoot: join(fixture.homeDir, ".ralph", "control"),
            controlFilePath: join(legacyDir, "control.json"),
            ralphVersion: "test",
            command: ["bun"],
            cwd: REPO_ROOT,
          },
          null,
          2
        )}\n`
      );

      const result = runRalphctl(["doctor", "--json"], buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome));
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout.trim());
      assertDoctorJsonV1(parsed);
      const findings = parsed.findings as Array<{ code?: string }>;
      expect(findings.some((finding) => finding.code === "DUPLICATE_LIVE_DAEMON_RECORDS")).toBeTrue();
      expect(findings.some((finding) => finding.code === "MULTIPLE_LIVE_DAEMON_RECORDS")).toBeFalse();
    } finally {
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("returns exit 2 for unknown doctor flags", async () => {
    const fixture = await createDoctorFixture({ staleCanonicalDaemon: true, includeCanonicalControl: false });
    try {
      const result = runRalphctl(
        ["doctor", "--json", "--unknown"],
        buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome)
      );
      expect(result.status).toBe(2);
      expect(() => JSON.parse(result.stdout)).toThrow();
      expect(result.stderr).toContain("Unknown doctor argument");
    } finally {
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("returns exit 2 for unexpected internal doctor failures", async () => {
    const fixture = await createDoctorFixture({ liveCanonicalDaemonPid: process.pid, includeCanonicalControl: true });
    try {
      const env = {
        ...buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome),
        RALPH_DOCTOR_FORCE_INTERNAL_ERROR: "1",
      };
      const result = runRalphctl(["doctor", "--json"], env);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Forced doctor internal error");
      expect(result.stdout.trim()).toBe("");
    } finally {
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("audit and dry-run modes do not mutate files", async () => {
    const fixture = await createDoctorFixture({ staleCanonicalDaemon: true, includeCanonicalControl: false });
    try {
      const env = buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome);
      const before = await snapshotFiles(fixture.homeDir);

      const audit = runRalphctl(["doctor", "--json"], env);
      expect(audit.status).toBe(1);
      const auditParsed = JSON.parse(audit.stdout.trim());
      assertDoctorJsonV1(auditParsed);
      expect(auditParsed.applied_repairs.length).toBe(0);

      const afterAudit = await snapshotFiles(fixture.homeDir);
      expect(afterAudit).toEqual(before);

      const dryRun = runRalphctl(["doctor", "--repair", "--dry-run", "--json"], env);
      expect(dryRun.status).toBe(1);
      const dryRunParsed = JSON.parse(dryRun.stdout.trim());
      assertDoctorJsonV1(dryRunParsed);
      expect(
        dryRunParsed.applied_repairs.length > 0 &&
          dryRunParsed.applied_repairs.every((entry) => entry.status === "skipped")
      ).toBeTrue();

      const afterDryRun = await snapshotFiles(fixture.homeDir);
      expect(afterDryRun).toEqual(before);
    } finally {
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("repair mode quarantines stale records and is idempotent", async () => {
    const fixture = await createDoctorFixture({ staleCanonicalDaemon: true, includeCanonicalControl: false });
    try {
      const env = buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome);
      const first = runRalphctl(["doctor", "--repair", "--json"], env);
      expect(first.status).toBe(1);
      const firstParsed = JSON.parse(first.stdout.trim());
      assertDoctorJsonV1(firstParsed);
      const firstApplied = (firstParsed.applied_repairs as Array<{ code?: string; status?: string }>).filter(
        (entry) => entry.code === "QUARANTINE_STALE_DAEMON_RECORDS"
      );
      expect(firstApplied.some((entry) => entry.status === "applied")).toBeTrue();

      const filesAfterFirst = await readdir(fixture.canonicalDir);
      const staleBackupsAfterFirst = filesAfterFirst.filter((name) => name.startsWith("daemon-registry.json.stale-"));
      expect(staleBackupsAfterFirst.length).toBe(1);

      const second = runRalphctl(["doctor", "--repair", "--json"], env);
      expect(second.status).toBe(1);
      const secondParsed = JSON.parse(second.stdout.trim());
      assertDoctorJsonV1(secondParsed);

      const filesAfterSecond = await readdir(fixture.canonicalDir);
      const staleBackupsAfterSecond = filesAfterSecond.filter((name) => name.startsWith("daemon-registry.json.stale-"));
      expect(staleBackupsAfterSecond.length).toBe(1);
      expect(staleBackupsAfterSecond).toEqual(staleBackupsAfterFirst);
      expect((secondParsed.applied_repairs as unknown[]).length).toBe(0);
    } finally {
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("repair mode does not quarantine canonical daemon record when PID is live", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("Failed to start long-lived child process for live-pid guard test.");
    }
    const fixture = await createDoctorFixture({
      liveCanonicalDaemonPid: child.pid,
      includeCanonicalControl: true,
    });
    try {
      const env = buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome);
      const result = runRalphctl(["doctor", "--repair", "--json"], env);
      const parsed = JSON.parse(result.stdout.trim());
      assertDoctorJsonV1(parsed);
      const files = await readdir(fixture.canonicalDir);
      expect(files.some((name) => name.startsWith("daemon-registry.json.stale-"))).toBeFalse();
      expect(files).toContain("daemon-registry.json");
      expect(
        (parsed.applied_repairs as Array<{ code?: string }>).every(
          (entry) => entry.code !== "QUARANTINE_STALE_DAEMON_RECORDS"
        )
      ).toBeTrue();
    } finally {
      if (typeof child.pid === "number") {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // best-effort
        }
      }
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });
});
