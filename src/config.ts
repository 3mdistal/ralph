import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

export type { WatchdogConfig, WatchdogThresholdMs, WatchdogThresholdsMs } from "./watchdog";
import type { WatchdogConfig } from "./watchdog";

export interface RepoConfig {
  name: string;      // "3mdistal/bwrb"
  path: string;      // "/Users/alicemoore/Developer/bwrb"
  botBranch: string; // "bot/integration"
  /** Max concurrent tasks for this repo (default: 1) */
  maxWorkers?: number;
}


export interface ThrottleWindowConfig {
  budgetTokens?: number;
}

export interface ThrottleResetRolling5hConfig {
  /** Reset hours in local time (default: [1, 6, 11, 16, 21]). */
  hours?: number[];
  /** Minute within the hour (default: 50). */
  minute?: number;
}

export interface ThrottleResetWeeklyConfig {
  /** Day of week in local time (0=Sun ... 6=Sat). Default: 4 (Thu). */
  dayOfWeek?: number;
  /** Hour in local time (0-23). Default: 19. */
  hour?: number;
  /** Minute within the hour. Default: 9. */
  minute?: number;
}

export interface ThrottleConfig {
  /** Enable usage-based throttling (default: true). */
  enabled?: boolean;
  /** Provider ID to count toward usage (default: "openai"). */
  providerID?: string;
  /** Soft throttle threshold as fraction of budget (default: 0.65). */
  softPct?: number;
  /** Hard throttle threshold (reserved for #72; default: 0.75). */
  hardPct?: number;
  /** Minimum interval between expensive usage scans (default: 15000ms). */
  minCheckIntervalMs?: number;
  windows?: {
    rolling5h?: ThrottleWindowConfig;
    weekly?: ThrottleWindowConfig;
  };
  reset?: {
    rolling5h?: ThrottleResetRolling5hConfig;
    weekly?: ThrottleResetWeeklyConfig;
  };
}

export interface RalphConfig {
  repos: RepoConfig[];
  /** Global max concurrent tasks across all repos (default: 6) */
  maxWorkers: number;
  batchSize: number;       // PRs before rollup (default: 10)
  pollInterval: number;    // ms between queue checks when polling (default: 30000)
  bwrbVault: string;       // path to bwrb vault for queue
  owner: string;           // GitHub owner for repos (default: "3mdistal")
  devDir: string;          // base directory for repos (default: ~/Developer)
  watchdog?: WatchdogConfig;
  throttle?: ThrottleConfig;
}

const DEFAULT_GLOBAL_MAX_WORKERS = 6;
const DEFAULT_REPO_MAX_WORKERS = 1;

const DEFAULT_CONFIG: RalphConfig = {
  repos: [],
  maxWorkers: DEFAULT_GLOBAL_MAX_WORKERS,
  batchSize: 10,
  pollInterval: 30000,
  bwrbVault: join(homedir(), "Developer/teenylilthoughts"),
  owner: "3mdistal",
  devDir: join(homedir(), "Developer"),
};

let config: RalphConfig | null = null;

function toPositiveIntOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value <= 0) return null;
  return value;
}

function validateConfig(loaded: RalphConfig): RalphConfig {
  const global = toPositiveIntOrNull((loaded as any).maxWorkers);
  if (!global) {
    const raw = (loaded as any).maxWorkers;
    if (raw !== undefined) {
      console.warn(
        `[ralph] Invalid config maxWorkers=${JSON.stringify(raw)}; falling back to default ${DEFAULT_GLOBAL_MAX_WORKERS}`
      );
    }
    loaded.maxWorkers = DEFAULT_GLOBAL_MAX_WORKERS;
  }

  // Validate per-repo maxWorkers. We keep it optional in the config, but sanitize invalid values.
  loaded.repos = (loaded.repos ?? []).map((repo) => {
    const mw = toPositiveIntOrNull((repo as any).maxWorkers);
    if ((repo as any).maxWorkers !== undefined && !mw) {
      console.warn(
        `[ralph] Invalid config maxWorkers for repo ${repo.name}: ${JSON.stringify((repo as any).maxWorkers)}; ` +
          `falling back to default ${DEFAULT_REPO_MAX_WORKERS}`
      );
      return { ...repo, maxWorkers: DEFAULT_REPO_MAX_WORKERS };
    }
    return repo;
  });

  return loaded;
}

export function loadConfig(): RalphConfig {
  if (config) return config;

  // Start with defaults
  let loaded: RalphConfig = { ...DEFAULT_CONFIG };

  // Try to load from file
  const configPath = join(homedir(), ".config/opencode/ralph/ralph.json");
  if (existsSync(configPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fileConfig = require(configPath);
      loaded = { ...loaded, ...fileConfig };
    } catch (e) {
      console.error(`[ralph] Failed to load config from ${configPath}:`, e);
    }
  }

  config = validateConfig(loaded);
  return config;
}

export function getRepoPath(repoName: string): string {
  const cfg = loadConfig();
  
  // Check if we have an explicit config for this repo
  const explicit = cfg.repos.find(r => r.name === repoName);
  if (explicit) return explicit.path;
  
  // Otherwise, derive from convention: ~/Developer/{repo-short-name}
  const shortName = repoName.includes("/") ? repoName.split("/")[1] : repoName;
  return join(cfg.devDir, shortName);
}

export function getRepoBotBranch(repoName: string): string {
  const cfg = loadConfig();
  const explicit = cfg.repos.find(r => r.name === repoName);
  return explicit?.botBranch ?? "bot/integration";
}

export function getGlobalMaxWorkers(): number {
  return loadConfig().maxWorkers;
}

export function getRepoMaxWorkers(repoName: string): number {
  const cfg = loadConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  const maxWorkers = toPositiveIntOrNull(explicit?.maxWorkers);
  return maxWorkers ?? DEFAULT_REPO_MAX_WORKERS;
}

export function normalizeRepoName(repo: string): string {
  const cfg = loadConfig();
  // If it's already full name, return as-is
  if (repo.includes("/")) return repo;
  // Otherwise, prepend owner
  return `${cfg.owner}/${repo}`;
}
