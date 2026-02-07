import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { readDaemonRecord } from "./daemon-record";
import {
  resolveCanonicalControlFilePath,
  resolveLegacyControlFilePathCandidates,
} from "./control-root";

export type DaemonMode = "running" | "draining" | "paused";

export type ControlState = {
  mode: DaemonMode;
  pauseRequested?: boolean;
  pauseAtCheckpoint?: string;
  drainTimeoutMs?: number;
};

export type ControlDefaults = {
  autoCreate: boolean;
  suppressMissingWarnings: boolean;
};

const CONTROL_FILE_VERSION = 1;

const DEFAULT_CONTROL_DEFAULTS: ControlDefaults = {
  autoCreate: true,
  suppressMissingWarnings: true,
};

function getControlDefaults(opts?: { defaults?: Partial<ControlDefaults> }): ControlDefaults {
  return {
    autoCreate: opts?.defaults?.autoCreate ?? DEFAULT_CONTROL_DEFAULTS.autoCreate,
    suppressMissingWarnings: opts?.defaults?.suppressMissingWarnings ?? DEFAULT_CONTROL_DEFAULTS.suppressMissingWarnings,
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveEffectiveControlFilePath(opts?: { homeDir?: string; xdgStateHome?: string; log?: (message: string) => void }): string {
  const record = readDaemonRecord({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome, log: opts?.log });
  const daemonControlPath =
    record && isPidAlive(record.pid) && record.controlFilePath.trim() ? record.controlFilePath.trim() : null;
  return daemonControlPath ?? resolveControlFilePath(opts?.homeDir, opts?.xdgStateHome);
}

export function resolveControlFilePath(
  homeDir?: string,
  xdgStateHome: string | undefined = process.env.XDG_STATE_HOME
): string {
  return resolveCanonicalControlFilePath({ homeDir });
}

export function resolveControlFilePathCandidates(
  homeDir?: string,
  xdgStateHome: string | undefined = process.env.XDG_STATE_HOME
): string[] {
  const canonical = resolveControlFilePath(homeDir, xdgStateHome);
  const legacy = resolveLegacyControlFilePathCandidates({ homeDir, xdgStateHome });
  return Array.from(new Set([canonical, ...legacy]));
}

function resolveReadableControlFilePath(opts?: {
  homeDir?: string;
  xdgStateHome?: string;
}): { path: string; hasExisting: boolean } {
  const candidates = resolveControlFilePathCandidates(opts?.homeDir, opts?.xdgStateHome);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, hasExisting: true };
  }
  return { path: candidates[0] ?? resolveControlFilePath(opts?.homeDir, opts?.xdgStateHome), hasExisting: false };
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

  const versionRaw = obj.version;
  const version = versionRaw === undefined ? 0 : versionRaw;

  if (version !== 0 && version !== CONTROL_FILE_VERSION) {
    throw new Error(
      `Invalid control schema: version must be ${CONTROL_FILE_VERSION} (got ${JSON.stringify(versionRaw)})`
    );
  }

  const mode = obj.mode;
  const allowPaused = version === CONTROL_FILE_VERSION;

  if (mode !== "running" && mode !== "draining" && (!allowPaused || mode !== "paused")) {
    const expected = allowPaused ? "'running', 'draining', or 'paused'" : "'running' or 'draining'";
    throw new Error(`Invalid control schema: mode must be ${expected} (got ${JSON.stringify(mode)})`);
  }

  const pauseRequestedRaw = obj.pause_requested;
  const pauseAtRaw = obj.pause_at_checkpoint;
  const drainTimeoutRaw = obj.drain_timeout_ms;
  const state: ControlState = { mode: mode as DaemonMode };

  if (typeof pauseRequestedRaw === "boolean") {
    state.pauseRequested = pauseRequestedRaw;
  }

  if (typeof pauseAtRaw === "string") {
    const trimmed = pauseAtRaw.trim();
    if (trimmed) state.pauseAtCheckpoint = trimmed;
  }

  if (typeof drainTimeoutRaw === "number" && Number.isFinite(drainTimeoutRaw) && drainTimeoutRaw >= 0) {
    state.drainTimeoutMs = drainTimeoutRaw;
  }

  return state;
}

function formatWarning(message: string): string {
  return `[ralph] ${message}`;
}

function formatInfo(message: string): string {
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

function isMissingControlFileError(reason: unknown): boolean {
  return reason instanceof Error && (reason as any).code === "ENOENT";
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

function writeDefaultControlFile(path: string, log?: (message: string) => void): boolean {
  if (existsSync(path)) return true;
  ensureControlParentDir(path, log);

  try {
    writeFileSync(
      path,
      `${JSON.stringify({ version: CONTROL_FILE_VERSION, mode: "running" }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" }
    );
    log?.(formatInfo(`Control file created at ${path} (defaulting to mode=running)`));
    return true;
  } catch (e: any) {
    if (e?.code === "EEXIST") return true;
    log?.(formatWarning(`Failed to write control file ${path} (reason: ${e?.message ?? String(e)})`));
    return false;
  }
}

export function readControlStateSnapshot(opts?: {
  homeDir?: string;
  xdgStateHome?: string;
  log?: (message: string) => void;
  defaults?: Partial<ControlDefaults>;
}): ControlState {
  const effectivePath = resolveEffectiveControlFilePath(opts);
  const readable = resolveReadableControlFilePath({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });
  const path = existsSync(effectivePath) ? effectivePath : readable.path;
  const defaults = getControlDefaults({ defaults: opts?.defaults });
  if (defaults.autoCreate && !readable.hasExisting && path === resolveControlFilePath(opts?.homeDir, opts?.xdgStateHome)) {
    writeDefaultControlFile(path, opts?.log);
  }

  try {
    assertSafeControlFile(path);
    const raw = readFileSync(path, "utf8");
    return parseControlStateJson(raw);
  } catch (e: any) {
    if (!defaults.suppressMissingWarnings || !isMissingControlFileError(e)) {
      opts?.log?.(formatWarning(describeControlReadFailure(path, e)));
    }
    return { mode: "running" };
  }
}

export function isDraining(homeDir?: string, defaults?: Partial<ControlDefaults>): boolean {
  return readControlStateSnapshot({ homeDir, defaults }).mode === "draining";
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
      onStateChange?: (state: ControlState) => void;
      defaults?: Partial<ControlDefaults>;
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

  private warnOnceForMissing(path: string, defaults: ControlDefaults): void {
    if (defaults.suppressMissingWarnings) return;
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
      this.options.onStateChange?.(this.state);
      return;
    }

    if (prevMode === nextMode) {
      this.state = next;
      this.options.onStateChange?.(this.state);
      return;
    }

    this.state = next;
    this.options.log?.(formatWarning(`Control mode: ${nextMode}`));
    this.options.onModeChange?.(nextMode);
    this.options.onStateChange?.(this.state);
  }

  private reloadNow(reason: string, opts?: { force?: boolean }): void {
    const canonicalPath = resolveControlFilePath(this.options.homeDir, this.options.xdgStateHome);
    const effectivePath = resolveEffectiveControlFilePath({
      homeDir: this.options.homeDir,
      xdgStateHome: this.options.xdgStateHome,
      log: this.options.warn ?? this.options.log,
    });
    const readable = resolveReadableControlFilePath({
      homeDir: this.options.homeDir,
      xdgStateHome: this.options.xdgStateHome,
    });
    let path = existsSync(effectivePath) ? effectivePath : readable.path;
    const defaults = getControlDefaults({ defaults: this.options.defaults });
    if (reason === "startup" && defaults.autoCreate && !readable.hasExisting) {
      writeDefaultControlFile(canonicalPath, this.options.warn ?? this.options.log);
      path = canonicalPath;
    }

    let mtimeMs: number | null = null;

    try {
      assertSafeControlFile(path);
      const stat = lstatSync(path);
      mtimeMs = stat.mtimeMs;
      this.lastMissing = false;
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        if (reason === "startup" && defaults.autoCreate && path === canonicalPath) {
          writeDefaultControlFile(canonicalPath, this.options.warn ?? this.options.log);
        }

        this.warnOnceForMissing(path, defaults);

        const fallback: ControlState = this.lastKnownGood ?? { mode: "running" };
        this.setState(fallback);
        this.lastSeenMtimeMs = null;
        return;
      }

      const warn = this.options.warn ?? this.options.log;
      warn?.(
        formatWarning(
          `Failed to stat control file ${path}; defaulting to mode=running (reason: ${e?.message ?? String(e)})`
        )
      );

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
