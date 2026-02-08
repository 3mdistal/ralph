import { homedir } from "os";
import { join } from "path";

function resolveHomeDirFallback(): string | undefined {
  const homeEnv = process.env.HOME?.trim();
  if (homeEnv) return homeEnv;
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

function resolveTmpRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  return join("/tmp", "ralph", String(uid));
}

export function resolveCanonicalControlRoot(opts?: { homeDir?: string }): string {
  const resolvedHome = opts?.homeDir?.trim() ?? resolveHomeDirFallback();
  if (resolvedHome) return join(resolvedHome, ".ralph", "control");
  return resolveTmpRoot();
}

export function resolveCanonicalControlFilePath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "control.json");
}

export function resolveCanonicalDaemonRegistryPath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "daemon-registry.json");
}

export function resolveCanonicalDaemonLockPath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "daemon.lock");
}

export function resolveCanonicalRegistryLockPath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "registry.lock");
}

export function resolveLegacyStateDir(opts?: { homeDir?: string; xdgStateHome?: string }): string {
  const trimmedStateHome = opts?.xdgStateHome?.trim() ?? process.env.XDG_STATE_HOME?.trim();
  if (trimmedStateHome) return join(trimmedStateHome, "ralph");

  const resolvedHome = opts?.homeDir?.trim() ?? resolveHomeDirFallback();
  if (resolvedHome) return join(resolvedHome, ".local", "state", "ralph");

  return resolveTmpRoot();
}

export function resolveLegacyControlFilePath(opts?: { homeDir?: string; xdgStateHome?: string }): string {
  return join(resolveLegacyStateDir(opts), "control.json");
}

export function resolveLegacyDaemonRecordPath(opts?: { homeDir?: string; xdgStateHome?: string }): string {
  return join(resolveLegacyStateDir(opts), "daemon.json");
}

export function resolveLegacyDaemonRecordCandidates(opts?: { homeDir?: string; xdgStateHome?: string }): string[] {
  const primary = resolveLegacyDaemonRecordPath(opts);
  const homeFallback = resolveLegacyDaemonRecordPath({ homeDir: opts?.homeDir, xdgStateHome: "" });
  const tmpFallback = join(resolveTmpRoot(), "daemon.json");
  return Array.from(new Set([primary, homeFallback, tmpFallback]));
}

export function resolveLegacyControlFileCandidates(opts?: { homeDir?: string; xdgStateHome?: string }): string[] {
  const primary = resolveLegacyControlFilePath(opts);
  const homeFallback = resolveLegacyControlFilePath({ homeDir: opts?.homeDir, xdgStateHome: "" });
  const tmpFallback = join(resolveTmpRoot(), "control.json");
  return Array.from(new Set([primary, homeFallback, tmpFallback]));
}
