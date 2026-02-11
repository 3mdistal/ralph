import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, spawnSync } from "child_process";

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const REPO_ROOT = process.cwd();

function buildIsolatedEnv(homeDir: string, xdgStateHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    XDG_STATE_HOME: xdgStateHome,
    XDG_CACHE_HOME: join(xdgStateHome, "cache"),
    XDG_CONFIG_HOME: join(xdgStateHome, "config"),
    BUN_INSTALL: join(xdgStateHome, ".bun"),
    BUN_INSTALL_CACHE_DIR: join(xdgStateHome, ".bun", "install", "cache"),
    RALPH_STATE_DB_PATH: join(homeDir, ".ralph", "state.sqlite"),
    RALPH_SESSIONS_DIR: join(homeDir, ".ralph", "sessions"),
    RALPH_WORKTREES_DIR: join(homeDir, ".ralph", "worktrees"),
    RALPH_GITHUB_QUEUE_DISABLE_SWEEPS: "1",
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

function parseJsonFromStdout(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`Expected JSON payload in stdout, got: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

async function createLegacyDaemonFixture(pid: number): Promise<{
  homeDir: string;
  xdgStateHome: string;
  legacyControlPath: string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "ralph-discovery-home-"));
  const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-discovery-xdg-"));
  const legacyRoot = join(xdgStateHome, "ralph");
  const legacyDaemonPath = join(legacyRoot, "daemon.json");
  const legacyControlPath = join(legacyRoot, "control.json");
  const canonicalRoot = join(homeDir, ".ralph", "control");

  await mkdir(legacyRoot, { recursive: true });
  await writeFile(
    legacyDaemonPath,
    `${JSON.stringify(
      {
        version: 1,
        daemonId: "legacy-live-daemon",
        pid,
        startedAt: "2026-02-09T00:00:00.000Z",
        heartbeatAt: "2026-02-09T00:10:00.000Z",
        controlRoot: canonicalRoot,
        controlFilePath: legacyControlPath,
        ralphVersion: "test",
        command: ["definitely-not-this-process"],
        cwd: REPO_ROOT,
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    legacyControlPath,
    `${JSON.stringify(
      {
        version: 1,
        mode: "running",
      },
      null,
      2
    )}\n`
  );

  return { homeDir, xdgStateHome, legacyControlPath };
}

describe("ralphctl profile-agnostic discovery", () => {
  test("status --json reports live daemon from legacy record when canonical record is absent", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("Failed to start child process for status discovery test.");
    }

    const fixture = await createLegacyDaemonFixture(child.pid);
    try {
      const env = buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome);
      const result = runRalphctl(["status", "--json"], env);
      expect(result.status).toBe(0);
      const parsed = parseJsonFromStdout(result.stdout) as {
        daemon: { pid: number | null; daemonId: string | null; controlFilePath: string | null } | null;
      };
      expect(parsed.daemon).not.toBeNull();
      expect(parsed.daemon?.pid).toBe(child.pid);
      expect(parsed.daemon?.daemonId).toBe("legacy-live-daemon");
      expect(parsed.daemon?.controlFilePath).toBe(fixture.legacyControlPath);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // best effort
      }
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });

  test("drain and resume target live daemon control file from legacy discovery", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("Failed to start child process for drain/resume test.");
    }

    const fixture = await createLegacyDaemonFixture(child.pid);
    try {
      const env = buildIsolatedEnv(fixture.homeDir, fixture.xdgStateHome);

      const drain = runRalphctl(["drain"], env);
      expect(drain.status).toBe(0);
      expect(drain.stdout).toContain(`Drain requested (control file: ${fixture.legacyControlPath}).`);

      const drainedControl = JSON.parse(await readFile(fixture.legacyControlPath, "utf8")) as { mode?: string };
      expect(drainedControl.mode).toBe("draining");

      const resume = runRalphctl(["resume"], env);
      expect(resume.status).toBe(0);
      expect(resume.stdout).toContain(`Resume requested (control file: ${fixture.legacyControlPath}).`);

      const resumedControl = JSON.parse(await readFile(fixture.legacyControlPath, "utf8")) as { mode?: string };
      expect(resumedControl.mode).toBe("running");
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // best effort
      }
      await rm(fixture.homeDir, { recursive: true, force: true });
      await rm(fixture.xdgStateHome, { recursive: true, force: true });
    }
  });
});
