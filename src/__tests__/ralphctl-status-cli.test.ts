import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { Database } from "bun:sqlite";

const REPO_ROOT = process.cwd();

function buildIsolatedEnv(homeDir: string, xdgStateHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    XDG_STATE_HOME: xdgStateHome,
    XDG_CACHE_HOME: join(xdgStateHome, "cache"),
    XDG_CONFIG_HOME: join(xdgStateHome, "config"),
    RALPH_STATE_DB_PATH: join(homeDir, ".ralph", "state.sqlite"),
    RALPH_SESSIONS_DIR: join(homeDir, ".ralph", "sessions"),
    RALPH_WORKTREES_DIR: join(homeDir, ".ralph", "worktrees"),
  };
}

function runRalphctl(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
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

describe("ralphctl status degraded mode", () => {
  test("status --json succeeds with forward-incompatible durable state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-status-cli-home-"));
    const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-status-cli-xdg-"));
    const stateDbPath = join(homeDir, ".ralph", "state.sqlite");
    await mkdir(join(homeDir, ".ralph"), { recursive: true });

    const db = new Database(stateDbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '999')");
    } finally {
      db.close();
    }

    try {
      const result = runRalphctl(["status", "--json"], buildIsolatedEnv(homeDir, xdgStateHome));
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, any>;
      expect(parsed.mode).toBeString();
      expect(parsed.inProgress).toEqual([]);
      expect(parsed.queued).toEqual([]);
      expect(parsed.durableState?.ok).toBeFalse();
      expect(parsed.durableState?.code).toBe("forward_incompatible");
      expect(parsed.durableState?.schemaVersion).toBe(999);
      expect(typeof parsed.durableState?.supportedRange).toBe("string");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(xdgStateHome, { recursive: true, force: true });
    }
  });
});
