import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

import { loadConfig } from "./config";
import { getRalphOpencodeConfigDir } from "./paths";

const TEMPLATE_DIR = fileURLToPath(new URL("./opencode-managed-config/templates", import.meta.url));
const MARKER_FILENAME = ".ralph-managed-opencode";
const MARKER_CONTENTS = "managed by ralph\n";
const LOCK_FILENAME = ".ralph-managed-opencode.lock";
const LOCK_ATTEMPTS = 20;
const LOCK_WAIT_MS = 50;
const LOCK_STALE_MS = 5 * 60_000;

type ManagedConfigFile = {
  path: string;
  contents: string;
};

export type ManagedConfigManifest = {
  configDir: string;
  files: ManagedConfigFile[];
};

function readTemplate(relativePath: string): string {
  const absolutePath = join(TEMPLATE_DIR, relativePath);
  return readFileSync(absolutePath, "utf8");
}

function ensureDir(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`[ralph] Refusing to write managed OpenCode config into symlink: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`[ralph] Managed OpenCode config path is not a directory: ${path}`);
    }
    return;
  }

  mkdirSync(path, { recursive: true });
}

function looksLikeManagedConfig(path: string): boolean {
  return existsSync(join(path, "opencode.json")) && existsSync(join(path, "agent"));
}

function assertSafeManagedConfigDir(path: string): void {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  const home = homedir();
  const ralphHome = resolve(getRalphOpencodeConfigDir(), "..");
  const markerPath = join(resolved, MARKER_FILENAME);
  const inHome = home ? !relative(resolve(home), resolved).startsWith("..") : false;

  if (resolved === root) {
    throw new Error(`[ralph] Refusing to manage OpenCode config at root directory: ${resolved}`);
  }

  if (home && resolve(home) === resolved) {
    throw new Error(`[ralph] Refusing to manage OpenCode config at HOME: ${resolved}`);
  }

  if (resolve(ralphHome) === resolved) {
    throw new Error(`[ralph] Refusing to manage OpenCode config at Ralph home dir: ${resolved}`);
  }

  if (!inHome && !existsSync(markerPath)) {
    throw new Error(
      `[ralph] Refusing to manage OpenCode config outside HOME without marker file ${MARKER_FILENAME}: ${resolved}`
    );
  }

  if (existsSync(resolved) && !existsSync(markerPath) && !looksLikeManagedConfig(resolved)) {
    throw new Error(
      `[ralph] Refusing to manage OpenCode config without marker file ${MARKER_FILENAME}: ${resolved}`
    );
  }
}

function writeFileAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, path);
}

function sleepMs(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function readLockInfo(path: string): { pid?: number; createdAt?: number } | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
    return parsed ?? null;
  } catch {
    return null;
  }
}

function isLockStale(info: { pid?: number; createdAt?: number } | null): boolean {
  if (!info?.pid || !info?.createdAt) return true;
  if (Date.now() - info.createdAt > LOCK_STALE_MS) return true;
  try {
    process.kill(info.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function withManagedConfigLock(dir: string, fn: () => void): void {
  const lockPath = join(dir, LOCK_FILENAME);
  let fd: number | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      fd = openSync(lockPath, "wx");
      const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      writeFileSync(fd, payload, "utf8");
      break;
    } catch (err: any) {
      lastError = err;
      if (err?.code !== "EEXIST") break;
      const info = readLockInfo(lockPath);
      if (isLockStale(info)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
        continue;
      }
      sleepMs(LOCK_WAIT_MS);
    }
  }

  if (fd == null) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
    throw new Error(
      `[ralph] Failed to acquire managed OpenCode config lock ${lockPath}: ${detail}. ` +
        `If this is stale, delete the lock file and retry.`
    );
  }

  try {
    fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

export function resolveManagedOpencodeConfigDir(): string {
  const envOverride = process.env.RALPH_OPENCODE_CONFIG_DIR?.trim();
  if (envOverride) {
    if (!isAbsolute(envOverride)) {
      throw new Error(
        `[ralph] RALPH_OPENCODE_CONFIG_DIR must be an absolute path (got ${JSON.stringify(envOverride)})`
      );
    }
    return envOverride;
  }

  const cfg = loadConfig();
  const configOverride = cfg.opencode?.managedConfigDir?.trim();
  if (configOverride) return configOverride;

  return getRalphOpencodeConfigDir();
}

export function getManagedOpencodeConfigManifest(configDir?: string): ManagedConfigManifest {
  const resolvedDir = configDir ?? resolveManagedOpencodeConfigDir();

  const files: ManagedConfigFile[] = [
    { path: join(resolvedDir, "opencode.json"), contents: readTemplate("opencode.json") },
    { path: join(resolvedDir, "agent", "build.md"), contents: readTemplate("agent/build.md") },
    { path: join(resolvedDir, "agent", "ralph-plan.md"), contents: readTemplate("agent/ralph-plan.md") },
    { path: join(resolvedDir, "agent", "product.md"), contents: readTemplate("agent/product.md") },
    { path: join(resolvedDir, "agent", "devex.md"), contents: readTemplate("agent/devex.md") },
    { path: join(resolvedDir, MARKER_FILENAME), contents: MARKER_CONTENTS },
  ];

  return { configDir: resolvedDir, files };
}

export function ensureManagedOpencodeConfigInstalled(configDir?: string): string {
  const manifest = getManagedOpencodeConfigManifest(configDir);
  const resolvedDir = manifest.configDir;

  if (!isAbsolute(resolvedDir)) {
    throw new Error(`[ralph] Managed OpenCode config dir must be absolute (got ${JSON.stringify(resolvedDir)})`);
  }

  assertSafeManagedConfigDir(resolvedDir);

  ensureDir(resolvedDir);
  ensureDir(join(resolvedDir, "agent"));

  withManagedConfigLock(resolvedDir, () => {
    for (const file of manifest.files) {
      const rel = relative(resolvedDir, file.path);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`[ralph] Refusing to write managed file outside config dir: ${file.path}`);
      }
      writeFileAtomic(file.path, file.contents);
    }
  });

  return resolvedDir;
}
