import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

export type { WatchdogConfig, WatchdogThresholdMs, WatchdogThresholdsMs } from "./watchdog";
import type { WatchdogConfig } from "./watchdog";

export interface RepoConfig {
  name: string;      // "3mdistal/bwrb"
  path: string;      // "/Users/alicemoore/Developer/bwrb"
  botBranch: string; // "bot/integration"
}


export interface RalphConfig {
  repos: RepoConfig[];
  batchSize: number;       // PRs before rollup (default: 10)
  pollInterval: number;    // ms between queue checks when polling (default: 30000)
  bwrbVault: string;       // path to bwrb vault for queue
  owner: string;           // GitHub owner for repos (default: "3mdistal")
  devDir: string;          // base directory for repos (default: ~/Developer)
  watchdog?: WatchdogConfig;
}

const DEFAULT_CONFIG: RalphConfig = {
  repos: [],
  batchSize: 10,
  pollInterval: 30000,
  bwrbVault: join(homedir(), "Developer/teenylilthoughts"),
  owner: "3mdistal",
  devDir: join(homedir(), "Developer"),
};

let config: RalphConfig | null = null;

export function loadConfig(): RalphConfig {
  if (config) return config;

  // Start with defaults
  let loaded: RalphConfig = { ...DEFAULT_CONFIG };

  // Try to load from file
  const configPath = join(homedir(), ".config/opencode/ralph/ralph.json");
  if (existsSync(configPath)) {
    try {
      const fileConfig = require(configPath);
      loaded = { ...loaded, ...fileConfig };
    } catch (e) {
      console.error(`[ralph] Failed to load config from ${configPath}:`, e);
    }
  }

  config = loaded;
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

function normalizeRepoName(repo: string): string {
  const cfg = loadConfig();
  // If it's already full name, return as-is
  if (repo.includes("/")) return repo;
  // Otherwise, prepend owner
  return `${cfg.owner}/${repo}`;
}
