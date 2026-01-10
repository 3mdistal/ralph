export interface WatchdogThresholdMs {
  softMs: number;
  hardMs: number;
}

export interface WatchdogThresholdsMs {
  read: WatchdogThresholdMs;
  glob: WatchdogThresholdMs;
  grep: WatchdogThresholdMs;
  task: WatchdogThresholdMs;
  bash: WatchdogThresholdMs;
}

export interface WatchdogConfig {
  enabled?: boolean;
  thresholdsMs?: Partial<WatchdogThresholdsMs>;
  softLogIntervalMs?: number;
  recentEventLimit?: number;
}

export const DEFAULT_WATCHDOG_THRESHOLDS_MS: WatchdogThresholdsMs = {
  read: { softMs: 30_000, hardMs: 120_000 },
  glob: { softMs: 30_000, hardMs: 120_000 },
  grep: { softMs: 30_000, hardMs: 120_000 },
  task: { softMs: 180_000, hardMs: 600_000 },
  bash: { softMs: 300_000, hardMs: 1_800_000 },
};
