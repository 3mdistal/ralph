import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { Database } from "bun:sqlite";
import { getDurableStateSchemaWindow } from "../state";

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
  test("status --json exposes writable capability on fresh state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-status-cli-home-"));
    const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-status-cli-xdg-"));
    try {
      const result = runRalphctl(["status", "--json"], buildIsolatedEnv(homeDir, xdgStateHome));
      expect(result.status).toBe(0);
      const jsonStart = result.stdout.indexOf("{");
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(result.stdout.slice(jsonStart)) as Record<string, any>;
      expect(parsed.durableState?.ok).toBeTrue();
      expect(parsed.durableState?.verdict).toBe("readable_writable");
      expect(parsed.durableState?.canReadState).toBeTrue();
      expect(parsed.durableState?.canWriteState).toBeTrue();
      expect(parsed.durableState?.requiresMigration).toBeFalse();
      expect(parsed.durableState?.minReadableSchema).toBeNumber();
      expect(parsed.durableState?.maxReadableSchema).toBeNumber();
      expect(parsed.durableState?.maxWritableSchema).toBeNumber();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(xdgStateHome, { recursive: true, force: true });
    }
  });

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
      expect(parsed.durableState?.verdict).toBe("unreadable_forward_incompatible");
      expect(parsed.durableState?.canReadState).toBeFalse();
      expect(parsed.durableState?.canWriteState).toBeFalse();
      expect(parsed.durableState?.requiresMigration).toBeTrue();
      expect(parsed.durableState?.schemaVersion).toBe(999);
      expect(typeof parsed.durableState?.supportedRange).toBe("string");
      expect(typeof parsed.durableState?.writableRange).toBe("string");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(xdgStateHome, { recursive: true, force: true });
    }
  });

  test("status --json exposes readable readonly capability for forward-newer in window", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-status-cli-home-"));
    const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-status-cli-xdg-"));
    const stateDbPath = join(homeDir, ".ralph", "state.sqlite");
    const writableSchema = getDurableStateSchemaWindow().maxWritableSchema;
    const forwardNewerSchema = writableSchema + 1;
    await mkdir(join(homeDir, ".ralph"), { recursive: true });

    const db = new Database(stateDbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec(`INSERT INTO meta(key, value) VALUES ('schema_version', '${forwardNewerSchema}')`);
    } finally {
      db.close();
    }

    try {
      const result = runRalphctl(["status", "--json"], buildIsolatedEnv(homeDir, xdgStateHome));
      expect(result.status).toBe(0);
      const jsonStart = result.stdout.indexOf("{");
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(result.stdout.slice(jsonStart)) as Record<string, any>;
      expect(parsed.mode).toBeString();
      expect(parsed.durableState?.ok).toBeTrue();
      expect(parsed.durableState?.verdict).toBe("readable_readonly_forward_newer");
      expect(parsed.durableState?.canReadState).toBeTrue();
      expect(parsed.durableState?.canWriteState).toBeFalse();
      expect(parsed.durableState?.requiresMigration).toBeTrue();
      expect(parsed.durableState?.schemaVersion).toBe(forwardNewerSchema);
      expect(parsed.durableState?.maxWritableSchema).toBeNumber();
      expect(parsed.durableState?.maxReadableSchema).toBeNumber();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(xdgStateHome, { recursive: true, force: true });
    }
  });
});
