import { homedir } from "os";
import { join } from "path";

function resolveTmpControlRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  return join("/tmp", "ralph", String(uid));
}

function resolveHomeDirFallback(): string | undefined {
  const homeEnv = process.env.HOME?.trim();
  if (homeEnv) return homeEnv;
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

function resolveCanonicalHome(opts?: { homeDir?: string }): string | undefined {
  if (opts?.homeDir !== undefined) {
    const trimmed = opts.homeDir.trim();
    return trimmed || undefined;
  }
  return resolveHomeDirFallback();
}

export function resolveCanonicalControlRoot(opts?: { homeDir?: string }): string {
  const home = resolveCanonicalHome(opts);
  if (home) return join(home, ".local", "state", "ralph");
  return resolveTmpControlRoot();
}

export function resolveLegacyXdgControlRoot(opts?: { xdgStateHome?: string }): string | null {
  const raw = opts?.xdgStateHome?.trim() ?? process.env.XDG_STATE_HOME?.trim();
  if (!raw) return null;
  return join(raw, "ralph");
}

export function resolveControlFilePath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "control.json");
}

export function resolveDaemonRecordPath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "daemon.json");
}

export function resolveDaemonLockDirPath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "daemon.lock.d");
}

export function resolveDaemonLockOwnerPath(opts?: { homeDir?: string }): string {
  return join(resolveDaemonLockDirPath(opts), "owner.json");
}

function dedupe(paths: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function resolveDaemonRecordPathCandidates(opts?: { homeDir?: string; xdgStateHome?: string }): string[] {
  const canonical = resolveDaemonRecordPath({ homeDir: opts?.homeDir });
  const legacyXdgRoot = resolveLegacyXdgControlRoot({ xdgStateHome: opts?.xdgStateHome });
  const legacyXdg = legacyXdgRoot ? join(legacyXdgRoot, "daemon.json") : null;
  const tmp = join(resolveTmpControlRoot(), "daemon.json");
  const includeTmp = !resolveCanonicalHome({ homeDir: opts?.homeDir });
  return dedupe([canonical, legacyXdg, includeTmp ? tmp : null]);
}
