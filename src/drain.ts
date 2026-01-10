import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type DaemonMode = "running" | "draining";

export function resolveDrainFilePath(homeDir: string = homedir()): string {
  return join(homeDir, ".config", "opencode", "ralph", "drain");
}

export function isDraining(homeDir?: string): boolean {
  return existsSync(resolveDrainFilePath(homeDir));
}

function modeFromDraining(draining: boolean): DaemonMode {
  return draining ? "draining" : "running";
}

export class DrainMonitor {
  private mode: DaemonMode = "running";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(
    private readonly options: {
      pollIntervalMs?: number;
      homeDir?: string;
      log?: (message: string) => void;
    } = {}
  ) {}

  start(): void {
    if (this.pollTimer) return;

    const pollIntervalMs = this.options.pollIntervalMs ?? 250;
    this.pollOnce();

    this.pollTimer = setInterval(() => {
      this.pollOnce();
    }, pollIntervalMs);
  }

  stop(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  getMode(): DaemonMode {
    return this.mode;
  }

  private pollOnce(): void {
    const draining = isDraining(this.options.homeDir);
    const nextMode = modeFromDraining(draining);

    if (!this.initialized) {
      this.initialized = true;
      this.mode = nextMode;
      if (draining) this.options.log?.("[ralph] Drain enabled");
      return;
    }

    if (nextMode === this.mode) return;

    this.mode = nextMode;
    if (draining) this.options.log?.("[ralph] Drain enabled");
    else this.options.log?.("[ralph] Drain disabled");
  }
}
