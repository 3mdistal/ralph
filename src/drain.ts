import { lstatSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type DaemonMode = "running" | "draining";

export type ControlState = {
  mode: DaemonMode;
  pauseRequested?: boolean;
  /** Active OpenCode profile for starting new tasks (control file key: opencode_profile). */
  opencodeProfile?: string;
};

function resolveTmpControlDir(): string {
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

export function resolveControlFilePath(
  homeDir?: string,
  xdgStateHome: string | undefined = process.env.XDG_STATE_HOME
): string {
  const trimmedStateHome = xdgStateHome?.trim();
  if (trimmedStateHome) return join(trimmedStateHome, "ralph", "control.json");

  const resolvedHome = homeDir?.trim() ?? resolveHomeDirFallback();
  if (resolvedHome) return join(resolvedHome, ".local", "state", "ralph", "control.json");

  return join(resolveTmpControlDir(), "control.json");
}

function ensureControlFileDir(path: string, opts?: { log?: (message: string) => void }): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e: any) {
    opts?.log?.(formatWarning(`Failed to create control directory for ${path} (reason: ${e?.message ?? String(e)})`));
  }
}

function parseControlStateJson(raw: string): ControlState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Invalid JSON: ${e?.message ?? String(e)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid control schema: expected a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const mode = obj.mode;

  if (mode !== "running" && mode !== "draining") {
    throw new Error(`Invalid control schema: mode must be 'running' or 'draining' (got ${JSON.stringify(mode)})`);
  }

  const pauseRequestedRaw = obj.pause_requested;
  const state: ControlState = { mode };

  if (typeof pauseRequestedRaw === "boolean") {
    state.pauseRequested = pauseRequestedRaw;
  }

  const opencodeProfileRaw = obj.opencode_profile;
  if (typeof opencodeProfileRaw === "string") {
    const trimmed = opencodeProfileRaw.trim();
    if (trimmed) state.opencodeProfile = trimmed;
  }

  return state;
}

function formatWarning(message: string): string {
  return `[ralph] ${message}`;
}

type Sigusr1Subscriber = () => void;

let sigusr1Installed = false;
const sigusr1Subscribers = new Set<Sigusr1Subscriber>();

const sigusr1Dispatcher = () => {
  for (const cb of Array.from(sigusr1Subscribers)) {
    try {
      cb();
    } catch {
      // ignore subscriber errors
    }
  }
};

function subscribeSigusr1(cb: Sigusr1Subscriber): () => void {
  if (!sigusr1Installed) {
    try {
      process.on("SIGUSR1", sigusr1Dispatcher);
      sigusr1Installed = true;
    } catch {
      // ignore
    }
  }

  sigusr1Subscribers.add(cb);

  return () => {
    sigusr1Subscribers.delete(cb);

    if (sigusr1Installed && sigusr1Subscribers.size === 0) {
      try {
        process.off("SIGUSR1", sigusr1Dispatcher);
      } catch {
        // ignore
      }
      sigusr1Installed = false;
    }
  };
}

function describeControlReadFailure(path: string, reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `Failed to load control file ${path}; defaulting to mode=running (reason: ${message})`;
}

function assertSafeControlFile(path: string): void {
  const dir = dirname(path);
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Control directory is not a directory: ${dir}`);
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error(`Control directory is a symlink: ${dir}`);
  }

  const fileStat = lstatSync(path);
  if (!fileStat.isFile()) {
    throw new Error(`Control file is not a regular file: ${path}`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Control file is a symlink: ${path}`);
  }
}

function ensureControlParentDir(path: string, log?: (message: string) => void): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    log?.(formatWarning(`Failed to ensure control dir ${dir}; continuing (reason: ${e?.message ?? String(e)})`));
  }
}

export function readControlStateSnapshot(opts?: {
  homeDir?: string;
  xdgStateHome?: string;
  log?: (message: string) => void;
}): ControlState {
  const path = resolveControlFilePath(opts?.homeDir, opts?.xdgStateHome);
  ensureControlParentDir(path, opts?.log);

  try {
    assertSafeControlFile(path);
    const raw = readFileSync(path, "utf8");
    return parseControlStateJson(raw);
  } catch (e: any) {
    opts?.log?.(formatWarning(describeControlReadFailure(path, e)));
    return { mode: "running" };
  }
}

export function isDraining(homeDir?: string): boolean {
  return readControlStateSnapshot({ homeDir }).mode === "draining";
}

export class DrainMonitor {
  private state: ControlState = { mode: "running" };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private lastKnownGood: ControlState | null = null;

  private lastSeenMtimeMs: number | null = null;
  private lastMissing = false;
  private lastWarnedInvalidMtimeMs: number | null = null;

  private unsubscribeSigusr1: (() => void) | null = null;

  constructor(
    private readonly options: {
      pollIntervalMs?: number;
      homeDir?: string;
      xdgStateHome?: string;
      log?: (message: string) => void;
      warn?: (message: string) => void;
      onModeChange?: (mode: DaemonMode) => void;
    } = {}
  ) {}

  start(): void {
    if (this.pollTimer) return;

    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;

    this.reloadNow("startup", { force: true });

    if (!this.unsubscribeSigusr1) {
      this.unsubscribeSigusr1 = subscribeSigusr1(() => {
        this.reloadNow("SIGUSR1");
      });
    }

    this.pollTimer = setInterval(() => {
      this.reloadNow("poll");
    }, pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.unsubscribeSigusr1) {
      this.unsubscribeSigusr1();
      this.unsubscribeSigusr1 = null;
    }
  }

  getMode(): DaemonMode {
    return this.state.mode;
  }

  getState(): ControlState {
    return this.state;
  }

  private warnOnceForMissing(path: string): void {
    if (this.lastMissing) return;
    this.lastMissing = true;

    const action = this.lastKnownGood
      ? `keeping last-known-good mode=${this.lastKnownGood.mode}`
      : "defaulting to mode=running";

    const warn = this.options.warn ?? this.options.log;
    warn?.(formatWarning(`Control file missing at ${path}; ${action}`));
  }

  private warnOnceForInvalid(path: string, mtimeMs: number | null, reason: string): void {
    if (mtimeMs != null && this.lastWarnedInvalidMtimeMs === mtimeMs) return;
    this.lastWarnedInvalidMtimeMs = mtimeMs;

    const action = this.lastKnownGood
      ? `keeping last-known-good mode=${this.lastKnownGood.mode}`
      : "defaulting to mode=running";

    const warn = this.options.warn ?? this.options.log;
    warn?.(formatWarning(`Control file invalid at ${path}; ${action} (reason: ${reason})`));
  }

  private setState(next: ControlState): void {
    const prevMode = this.state.mode;
    const nextMode = next.mode;

    if (!this.initialized) {
      this.initialized = true;
      this.state = next;
      if (nextMode !== "running") {
        this.options.log?.(formatWarning(`Control mode: ${nextMode}`));
      }
      return;
    }

    if (prevMode === nextMode) {
      this.state = next;
      return;
    }

    this.state = next;
    this.options.log?.(formatWarning(`Control mode: ${nextMode}`));
    this.options.onModeChange?.(nextMode);
  }

  private reloadNow(reason: string, opts?: { force?: boolean }): void {
    const path = resolveControlFilePath(this.options.homeDir, this.options.xdgStateHome);
    if (reason === "startup") {
      ensureControlFileDir(path, { log: this.options.warn ?? this.options.log });
    }

    let mtimeMs: number | null = null;

    try {
      assertSafeControlFile(path);
      const stat = lstatSync(path);
      mtimeMs = stat.mtimeMs;
      this.lastMissing = false;
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        if (reason === "startup") {
          ensureControlFileDir(path, { log: this.options.warn ?? this.options.log });
        }

        this.warnOnceForMissing(path);

        const fallback: ControlState = this.lastKnownGood ?? { mode: "running" };
        this.setState(fallback);
        this.lastSeenMtimeMs = null;
        return;
      }

      const warn = this.options.warn ?? this.options.log;
      warn?.(formatWarning(`Failed to stat control file ${path}; defaulting to mode=running (reason: ${e?.message ?? String(e)})`));

      const fallback: ControlState = this.lastKnownGood ?? { mode: "running" };
      this.setState(fallback);
      this.lastSeenMtimeMs = null;
      return;
    }

    const force = opts?.force ?? false;
    if (!force && this.lastSeenMtimeMs != null && mtimeMs === this.lastSeenMtimeMs) return;

    this.lastSeenMtimeMs = mtimeMs;

    try {
      const raw = readFileSync(path, "utf8");
      const next = parseControlStateJson(raw);

      this.lastKnownGood = next;
      this.lastWarnedInvalidMtimeMs = null;

      this.setState(next);
    } catch (e: any) {
      this.warnOnceForInvalid(path, mtimeMs, e?.message ?? String(e));

      const fallback: ControlState = this.lastKnownGood ?? { mode: "running" };
      this.setState(fallback);
    }
  }
}
