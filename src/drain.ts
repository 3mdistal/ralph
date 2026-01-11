import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type DaemonMode = "running" | "draining";

export type ControlState = {
  mode: DaemonMode;
  pauseRequested?: boolean;
};

export function resolveControlFilePath(
  homeDir: string = homedir(),
  xdgStateHome: string | undefined = process.env.XDG_STATE_HOME
): string {
  const stateHome = xdgStateHome?.trim() ? xdgStateHome.trim() : join(homeDir, ".local", "state");
  return join(stateHome, "ralph", "control.json");
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

  return state;
}

function formatWarning(message: string): string {
  return `[ralph] ${message}`;
}

export function readControlStateSnapshot(opts?: {
  homeDir?: string;
  xdgStateHome?: string;
  log?: (message: string) => void;
}): ControlState {
  const path = resolveControlFilePath(opts?.homeDir, opts?.xdgStateHome);

  try {
    const raw = readFileSync(path, "utf8");
    return parseControlStateJson(raw);
  } catch (e: any) {
    opts?.log?.(
      formatWarning(
        `Failed to load control file ${path}; defaulting to mode=running (reason: ${e?.message ?? String(e)})`
      )
    );

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

  private readonly sigusr1Handler = () => {
    this.reloadNow("SIGUSR1");
  };

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

    try {
      process.on("SIGUSR1", this.sigusr1Handler);
    } catch {
      // best-effort; signal support can vary
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

    try {
      process.off("SIGUSR1", this.sigusr1Handler);
    } catch {
      // ignore
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

    let mtimeMs: number | null = null;

    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      this.lastMissing = false;
    } catch (e: any) {
      if (e?.code === "ENOENT") {
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
