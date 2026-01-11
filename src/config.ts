import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

import { getRalphConfigJsonPath, getRalphConfigTomlPath, getRalphLegacyConfigPath } from "./paths";

export type { WatchdogConfig, WatchdogThresholdMs, WatchdogThresholdsMs } from "./watchdog";
import type { WatchdogConfig } from "./watchdog";

export interface RepoConfig {
  name: string;      // "3mdistal/bwrb"
  path: string;      // "/Users/alicemoore/Developer/bwrb"
  botBranch: string; // "bot/integration"
  /**
   * Required status checks for merge gating (default: ["ci"]).
   *
   * Values must match the check context name shown by GitHub.
   * Set to [] to disable merge gating for a repo.
   */
  requiredChecks?: string[];
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
  owner: string;           // default GitHub owner (default: "3mdistal")

  /**
   * Guardrail: only touch repos whose owner is in this allowlist.
   * Default: [owner].
   */
  allowedOwners?: string[];

  /** GitHub App auth (installation token) used for gh + REST calls. */
  githubApp?: {
    appId: number | string;
    installationId: number | string;
    /** PEM file path (read at runtime; never log key material). */
    privateKeyPath: string;
  };

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

function toStringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];

  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (!trimmed) return null;
    items.push(trimmed);
  }
  return items;
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

  // Guardrail allowlist. Default to [owner].
  const rawOwners = (loaded as any).allowedOwners;
  if (Array.isArray(rawOwners)) {
    const cleaned = rawOwners.map((v) => String(v ?? "").trim()).filter(Boolean);
    if (cleaned.length === 0) {
      console.warn(`[ralph] Invalid config allowedOwners=[]; defaulting to [${JSON.stringify(loaded.owner)}]`);
      loaded.allowedOwners = [loaded.owner];
    } else {
      loaded.allowedOwners = cleaned;
    }
  } else if (rawOwners !== undefined) {
    console.warn(`[ralph] Invalid config allowedOwners=${JSON.stringify(rawOwners)}; defaulting to [${JSON.stringify(loaded.owner)}]`);
    loaded.allowedOwners = [loaded.owner];
  } else {
    loaded.allowedOwners = [loaded.owner];
  }

  // Best-effort validation for GitHub App auth config.
  const rawGithubApp = (loaded as any).githubApp;
  if (rawGithubApp !== undefined && rawGithubApp !== null && typeof rawGithubApp !== "object") {
    console.warn(`[ralph] Invalid config githubApp=${JSON.stringify(rawGithubApp)}; ignoring`);
    (loaded as any).githubApp = undefined;
  }

  return loaded;
}

export function loadConfig(): RalphConfig {
  if (config) return config;

  // Start with defaults
  let loaded: RalphConfig = { ...DEFAULT_CONFIG };

  // Try to load from file (precedence: ~/.ralph/config.toml > ~/.ralph/config.json > legacy ~/.config/opencode/ralph/ralph.json)
  const configTomlPath = getRalphConfigTomlPath();
  const configJsonPath = getRalphConfigJsonPath();
  const legacyConfigPath = getRalphLegacyConfigPath();

  const tryLoadJson = (path: string): any | null => {
    try {
      const text = readFileSync(path, "utf8");
      return JSON.parse(text);
    } catch (e) {
      console.error(`[ralph] Failed to load JSON config from ${path}:`, e);
      return null;
    }
  };

  const tryLoadToml = (path: string): any | null => {
    try {
      const text = readFileSync(path, "utf8");
      const toml = (Bun as any)?.TOML;
      if (!toml || typeof toml.parse !== "function") {
        throw new Error("Bun.TOML.parse is not available in this runtime");
      }
      return toml.parse(text);
    } catch (e) {
      console.error(`[ralph] Failed to load TOML config from ${path}:`, e);
      return null;
    }
  };

  if (existsSync(configTomlPath)) {
    const fileConfig = tryLoadToml(configTomlPath);
    if (fileConfig) loaded = { ...loaded, ...fileConfig };
  } else if (existsSync(configJsonPath)) {
    const fileConfig = tryLoadJson(configJsonPath);
    if (fileConfig) loaded = { ...loaded, ...fileConfig };
  } else if (existsSync(legacyConfigPath)) {
    console.warn(
      `[ralph] Using legacy config path ${legacyConfigPath}. ` +
        `Migrate to ${configTomlPath} or ${configJsonPath} (preferred).`
    );

    const fileConfig = tryLoadJson(legacyConfigPath);
    if (fileConfig) loaded = { ...loaded, ...fileConfig };
  }

  config = validateConfig(loaded);
  return config;
}

export function __resetConfigForTests(): void {
  config = null;
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

export function getRepoRequiredChecks(repoName: string): string[] {
  const cfg = loadConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  const checks = toStringArrayOrNull(explicit?.requiredChecks);
  return checks ?? ["ci"];
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
