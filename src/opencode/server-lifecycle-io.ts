import { spawn as nodeSpawn, type ChildProcess } from "child_process";

import { registerOpencodeRun, unregisterOpencodeRun } from "../opencode-process-registry";
import { buildOpencodeSpawnEnvironment, resolveOpencodeBin, type RunSessionOptionsBase } from "../session";
import type { OpencodeTransportFailure } from "./transport-types";

type SpawnFn = typeof nodeSpawn;

type ServerRecord = {
  key: string;
  repoPath: string;
  url: string;
  port: number;
  process: ChildProcess;
  pgid: number;
};

type EnsureServerOptions = {
  repoPath: string;
  options?: RunSessionOptionsBase;
};

const START_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildServerKey(repoPath: string, options?: RunSessionOptionsBase): string {
  const profile = JSON.stringify(options?.opencodeXdg ?? {});
  return `${normalizeKey(repoPath)}::${profile}`;
}

function randomPort(): number {
  return 4100 + Math.floor(Math.random() * 2000);
}

async function probeHealth(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class OpencodeServerLifecycle {
  private readonly servers = new Map<string, ServerRecord>();
  private readonly inflight = new Map<string, Promise<ServerRecord>>();
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: typeof fetch;

  constructor(opts?: { spawn?: SpawnFn; fetch?: typeof fetch }) {
    this.spawnFn = opts?.spawn ?? nodeSpawn;
    this.fetchFn = opts?.fetch ?? fetch;
  }

  async ensureServer(params: EnsureServerOptions): Promise<{ baseUrl: string; key: string }> {
    const key = buildServerKey(params.repoPath, params.options);
    const current = this.servers.get(key);
    if (current) {
      const healthy = await probeHealth(current.url, this.fetchFn);
      if (healthy) {
        return { baseUrl: current.url, key };
      }
      this.stopServer(current);
    }

    const existing = this.inflight.get(key);
    if (existing) {
      const reused = await existing;
      return { baseUrl: reused.url, key };
    }

    const next = this.spawnServer(key, params);
    this.inflight.set(key, next);
    try {
      const record = await next;
      return { baseUrl: record.url, key };
    } finally {
      this.inflight.delete(key);
    }
  }

  async stopAll(): Promise<void> {
    for (const record of this.servers.values()) {
      this.stopServer(record);
    }
    this.servers.clear();
  }

  private stopServer(record: ServerRecord): void {
    try {
      unregisterOpencodeRun(record.pgid);
    } catch {
      // ignore
    }
    try {
      if (!record.process.killed) record.process.kill();
    } catch {
      // ignore
    }
  }

  private async spawnServer(key: string, params: EnsureServerOptions): Promise<ServerRecord> {
    const port = randomPort();
    const { env } = buildOpencodeSpawnEnvironment({
      repo: params.options?.repo,
      cacheKey: `${params.options?.cacheKey ?? "default"}-server`,
      tempDir: params.options?.tempDir,
      opencodeXdg: params.options?.opencodeXdg,
    });

    const proc = this.spawnFn(resolveOpencodeBin(), ["serve", "--port", String(port)], {
      cwd: params.repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      ...(process.platform !== "win32" ? { detached: true } : {}),
    });

    const runMeta = registerOpencodeRun(proc, {
      useProcessGroup: process.platform !== "win32",
      command: "serve",
      kind: "server",
    });

    const cleanup = () => {
      if (runMeta) unregisterOpencodeRun(runMeta.pgid);
    };
    proc.on("close", cleanup);
    proc.on("error", cleanup);

    const baseUrl = `http://127.0.0.1:${port}`;
    const started = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const timer = setTimeout(() => {
        settle(false);
      }, START_TIMEOUT_MS);

      proc.stdout?.on("data", (buffer: Buffer) => {
        const value = buffer.toString();
        if (value.includes("ready") || value.includes("listening") || value.includes(String(port))) {
          clearTimeout(timer);
          settle(true);
        }
      });

      proc.on("error", () => {
        clearTimeout(timer);
        settle(false);
      });
      proc.on("exit", () => {
        clearTimeout(timer);
        settle(false);
      });
    });

    if (!started) {
      try {
        if (!proc.killed) proc.kill();
      } catch {
        // ignore
      }
      const reason: OpencodeTransportFailure = {
        code: "server-start-failed",
        message: "OpenCode server failed to start before timeout",
      };
      throw reason;
    }

    const healthy = await probeHealth(baseUrl, this.fetchFn);
    if (!healthy) {
      try {
        if (!proc.killed) proc.kill();
      } catch {
        // ignore
      }
      const reason: OpencodeTransportFailure = {
        code: "server-health-failed",
        message: `OpenCode server health check failed at ${baseUrl}`,
      };
      throw reason;
    }

    const record: ServerRecord = {
      key,
      repoPath: params.repoPath,
      url: baseUrl,
      port,
      process: proc,
      pgid: runMeta?.pgid ?? proc.pid ?? port,
    };
    this.servers.set(key, record);
    return record;
  }
}
