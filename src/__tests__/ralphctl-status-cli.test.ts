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

function parseStatusJson(stdout: string): Record<string, any> {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) throw new Error(`status output missing json payload: ${stdout}`);
  return JSON.parse(stdout.slice(jsonStart)) as Record<string, any>;
}

function seedSchemaVersion(stateDbPath: string, version: number): void {
  const db = new Database(stateDbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("DELETE FROM meta WHERE key = 'schema_version'");
    db.exec(`INSERT INTO meta(key, value) VALUES ('schema_version', '${version}')`);
  } finally {
    db.close();
  }
}

function readSchemaVersion(stateDbPath: string): number | null {
  const db = new Database(stateDbPath, { readonly: true });
  try {
    const row = db
      .query("SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1")
      .get() as { value?: string | number | null } | undefined;
    if (!row || row.value == null) return null;
    const value = Number(row.value);
    return Number.isFinite(value) ? value : null;
  } finally {
    db.close();
  }
}

describe("ralphctl status degraded mode", () => {
  test("status --json exposes writable capability on fresh state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-status-cli-home-"));
    const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-status-cli-xdg-"));
    try {
      const result = runRalphctl(["status", "--json"], buildIsolatedEnv(homeDir, xdgStateHome));
      expect(result.status).toBe(0);
      const parsed = parseStatusJson(result.stdout);
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
      const parsed = parseStatusJson(result.stdout);
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
      const parsed = parseStatusJson(result.stdout);
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

  test("status migrates older durable state (old daemon -> newer ctl)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-status-cli-home-"));
    const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-status-cli-xdg-"));
    const stateDbPath = join(homeDir, ".ralph", "state.sqlite");
    const writableSchema = getDurableStateSchemaWindow().maxWritableSchema;
    await mkdir(join(homeDir, ".ralph"), { recursive: true });
    seedSchemaVersion(stateDbPath, writableSchema - 1);

    try {
      const result = runRalphctl(["status", "--json"], buildIsolatedEnv(homeDir, xdgStateHome));
      expect(result.status).toBe(0);
      const parsed = parseStatusJson(result.stdout);
      expect(parsed.durableState?.ok).toBeTrue();
      expect(parsed.durableState?.verdict).toBe("readable_writable");
      expect(parsed.durableState?.canWriteState).toBeTrue();
      expect(readSchemaVersion(stateDbPath)).toBe(writableSchema);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(xdgStateHome, { recursive: true, force: true });
    }
  });

  test("status resumes after migration lock contention is cleared", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-status-cli-home-"));
    const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-status-cli-xdg-"));
    const stateDbPath = join(homeDir, ".ralph", "state.sqlite");
    const writableSchema = getDurableStateSchemaWindow().maxWritableSchema;
    await mkdir(join(homeDir, ".ralph"), { recursive: true });
    seedSchemaVersion(stateDbPath, writableSchema - 1);

    const lockDb = new Database(stateDbPath);
    lockDb.exec("BEGIN EXCLUSIVE");
    try {
      const lockedEnv = {
        ...buildIsolatedEnv(homeDir, xdgStateHome),
        RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS: "25",
      };
      const locked = runRalphctl(["status", "--json"], lockedEnv);
      expect(locked.status).toBe(0);
      const degraded = parseStatusJson(locked.stdout);
      expect(degraded.durableState?.ok).toBeFalse();
      expect(degraded.durableState?.code).toBe("lock_timeout");
    } finally {
      lockDb.exec("ROLLBACK");
      lockDb.close();
    }

    try {
      const resumed = runRalphctl(["status", "--json"], buildIsolatedEnv(homeDir, xdgStateHome));
      expect(resumed.status).toBe(0);
      const parsed = parseStatusJson(resumed.stdout);
      expect(parsed.durableState?.ok).toBeTrue();
      expect(parsed.durableState?.verdict).toBe("readable_writable");
      expect(readSchemaVersion(stateDbPath)).toBe(writableSchema);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(xdgStateHome, { recursive: true, force: true });
    }
  });

  test("pending drain intent remains visible while status triggers migration", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ralph-status-cli-home-"));
    const xdgStateHome = await mkdtemp(join(tmpdir(), "ralph-status-cli-xdg-"));
    const stateDbPath = join(homeDir, ".ralph", "state.sqlite");
    const writableSchema = getDurableStateSchemaWindow().maxWritableSchema;
    await mkdir(join(homeDir, ".ralph"), { recursive: true });
    seedSchemaVersion(stateDbPath, writableSchema - 1);

    try {
      const env = buildIsolatedEnv(homeDir, xdgStateHome);
      const drain = runRalphctl(["drain", "--timeout", "30s"], env);
      expect(drain.status).toBe(0);

      const status = runRalphctl(["status", "--json"], env);
      expect(status.status).toBe(0);
      const parsed = parseStatusJson(status.stdout);
      expect(parsed.mode).toBe("draining");
      expect(parsed.durableState?.ok).toBeTrue();
      expect(parsed.durableState?.canWriteState).toBeTrue();
      expect(readSchemaVersion(stateDbPath)).toBe(writableSchema);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(xdgStateHome, { recursive: true, force: true });
    }
  });
});
