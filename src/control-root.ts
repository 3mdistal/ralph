import { homedir } from "os";
import { join } from "path";

function resolveHomeDir(): string | null {
  const raw = process.env.HOME?.trim();
  if (raw) return raw;
  try {
    const detected = homedir();
    return detected?.trim() ? detected : null;
  } catch {
    return null;
  }
}

function resolveTmpStateDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  return join("/tmp", "ralph", String(uid));
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

export function resolveCanonicalControlRoot(opts?: { homeDir?: string }): string {
  const explicitHome =
    opts && Object.prototype.hasOwnProperty.call(opts, "homeDir") && opts.homeDir !== undefined
      ? opts.homeDir?.trim() ?? ""
      : null;
  const home = explicitHome !== null ? explicitHome : resolveHomeDir();
  if (home) return join(home, ".ralph", "control");
  return join(resolveTmpStateDir(), "control");
}

export function resolveCanonicalControlFilePath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "control.json");
}

export function resolveCanonicalDaemonRegistryPath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot(opts), "daemon-registry.json");
}

export function resolveLegacyStateDirCandidates(opts?: { homeDir?: string; xdgStateHome?: string }): string[] {
  const xdg = opts?.xdgStateHome?.trim() ?? process.env.XDG_STATE_HOME?.trim() ?? "";
  const explicitHome =
    opts && Object.prototype.hasOwnProperty.call(opts, "homeDir") && opts.homeDir !== undefined
      ? opts.homeDir?.trim() ?? ""
      : null;
  const home = explicitHome !== null ? explicitHome : resolveHomeDir() || "";

  const dirs: string[] = [];
  if (xdg) dirs.push(join(xdg, "ralph"));
  if (home) dirs.push(join(home, ".local", "state", "ralph"));
  dirs.push(resolveTmpStateDir());
  return dedupe(dirs);
}

export function resolveLegacyControlFilePathCandidates(opts?: { homeDir?: string; xdgStateHome?: string }): string[] {
  return dedupe(resolveLegacyStateDirCandidates(opts).map((dir) => join(dir, "control.json")));
}

export function resolveLegacyDaemonRegistryPathCandidates(opts?: { homeDir?: string; xdgStateHome?: string }): string[] {
  return dedupe(resolveLegacyStateDirCandidates(opts).map((dir) => join(dir, "daemon.json")));
}
