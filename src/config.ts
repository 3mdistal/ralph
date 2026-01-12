import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";

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

export interface ThrottlePerProfileConfig {
  enabled?: boolean;
  providerID?: string;
  softPct?: number;
  hardPct?: number;
  minCheckIntervalMs?: number;
  windows?: {
    rolling5h?: ThrottleWindowConfig;
    weekly?: ThrottleWindowConfig;
  };
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
  /** Optional per-profile overrides keyed by OpenCode profile name. */
  perProfile?: Record<string, ThrottlePerProfileConfig>;
}

export interface OpencodeProfileConfig {
  /** Absolute path for $XDG_DATA_HOME */
  xdgDataHome: string;
  /** Absolute path for $XDG_CONFIG_HOME */
  xdgConfigHome: string;
  /** Absolute path for $XDG_STATE_HOME */
  xdgStateHome: string;
  /** Optional absolute path for $XDG_CACHE_HOME (Ralph still isolates per task). */
  xdgCacheHome?: string;
}

export interface OpencodeConfig {
  /** Enable named OpenCode XDG profiles (default: true if section present). */
  enabled?: boolean;
  /** Default profile name for new tasks when control override missing. */
  defaultProfile?: string;
  /** Named profiles keyed by their identifier (e.g. "apple", "google"). */
  profiles?: Record<string, OpencodeProfileConfig>;
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
  opencode?: OpencodeConfig;
}

const DEFAULT_GLOBAL_MAX_WORKERS = 6;
const DEFAULT_REPO_MAX_WORKERS = 1;

const DEFAULT_THROTTLE_PROVIDER_ID = "openai";
const DEFAULT_THROTTLE_SOFT_PCT = 0.65;
const DEFAULT_THROTTLE_HARD_PCT = 0.75;
const DEFAULT_THROTTLE_MIN_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_THROTTLE_BUDGET_5H_TOKENS = 16_987_015;
const DEFAULT_THROTTLE_BUDGET_WEEKLY_TOKENS = 55_769_305;

function detectDefaultBwrbVault(): string {
  const start = process.cwd();
  let dir = start;

  for (;;) {
    if (existsSync(join(dir, ".bwrb", "schema.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function ensureBwrbVaultLayout(vault: string): boolean {
  if (!vault || !existsSync(vault)) {
    console.error(
      `[ralph] bwrbVault is missing or invalid: ${JSON.stringify(vault)}. ` +
        `Set it in ~/.ralph/config.toml or ~/.ralph/config.json (key: bwrbVault).`
    );
    return false;
  }

  const schemaPath = join(vault, ".bwrb", "schema.json");
  if (!existsSync(schemaPath)) {
    console.error(
      `[ralph] bwrbVault does not contain a bwrb schema: ${JSON.stringify(vault)} (missing ${schemaPath}). ` +
        `Point bwrbVault at a directory that contains .bwrb/schema.json.`
    );
    return false;
  }

  const dirs = [
    "orchestration/tasks",
    "orchestration/runs",
    "orchestration/escalations",
    "orchestration/notifications",
  ];

  try {
    for (const rel of dirs) {
      mkdirSync(join(vault, rel), { recursive: true });
    }
    return true;
  } catch (e) {
    console.error(`[ralph] Failed to create orchestration directories in ${vault}:`, e);
    return false;
  }
}

const DEFAULT_CONFIG: RalphConfig = {
  repos: [],
  maxWorkers: DEFAULT_GLOBAL_MAX_WORKERS,
  batchSize: 10,
  pollInterval: 30000,
  bwrbVault: detectDefaultBwrbVault(),
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

function toNonNegativeIntOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored < 0) return null;
  return floored;
}

function toPctOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
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

  // Best-effort validation for OpenCode profile config.
  const rawOpencode = (loaded as any).opencode;
  if (rawOpencode !== undefined && rawOpencode !== null && (typeof rawOpencode !== "object" || Array.isArray(rawOpencode))) {
    console.warn(`[ralph] Invalid config opencode=${JSON.stringify(rawOpencode)}; ignoring`);
    (loaded as any).opencode = undefined;
  } else if (rawOpencode && typeof rawOpencode === "object") {
    const enabledRaw = (rawOpencode as any).enabled;
    let enabled = true;
    if (enabledRaw !== undefined) {
      if (typeof enabledRaw === "boolean") {
        enabled = enabledRaw;
      } else {
        console.warn(`[ralph] Invalid config opencode.enabled=${JSON.stringify(enabledRaw)}; defaulting to true`);
        enabled = true;
      }
    }

    const rawProfiles = (rawOpencode as any).profiles;
    const profiles: Record<string, OpencodeProfileConfig> = {};

    if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
      for (const [rawName, rawProfile] of Object.entries(rawProfiles as Record<string, unknown>)) {
        const name = String(rawName ?? "").trim();
        if (!name) continue;

        if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
          console.warn(`[ralph] Invalid config opencode.profiles.${name}=${JSON.stringify(rawProfile)}; skipping`);
          continue;
        }

        const profileObj = rawProfile as Record<string, unknown>;

        const readAbs = (key: string, required: boolean): string | null => {
          const raw = profileObj[key];
          if (typeof raw !== "string") {
            if (required) console.warn(`[ralph] Invalid config opencode.profiles.${name}.${key}=${JSON.stringify(raw)}; skipping profile`);
            return required ? null : null;
          }
          const trimmed = raw.trim();
          if (!trimmed) {
            if (required) console.warn(`[ralph] Invalid config opencode.profiles.${name}.${key}=""; skipping profile`);
            return required ? null : null;
          }
          if (!isAbsolute(trimmed)) {
            console.warn(
              `[ralph] Invalid config opencode.profiles.${name}.${key}=${JSON.stringify(trimmed)}; must be an absolute path (no '~' expansion). Skipping profile.`
            );
            return null;
          }
          return trimmed;
        };

        const xdgDataHome = readAbs("xdgDataHome", true);
        const xdgConfigHome = readAbs("xdgConfigHome", true);
        const xdgStateHome = readAbs("xdgStateHome", true);
        if (!xdgDataHome || !xdgConfigHome || !xdgStateHome) continue;

        const xdgCacheHome = readAbs("xdgCacheHome", false);

        profiles[name] = {
          xdgDataHome,
          xdgConfigHome,
          xdgStateHome,
          ...(xdgCacheHome ? { xdgCacheHome } : {}),
        };
      }
    } else if (rawProfiles !== undefined) {
      console.warn(`[ralph] Invalid config opencode.profiles=${JSON.stringify(rawProfiles)}; ignoring`);
    }

    const profileNames = Object.keys(profiles).sort();
    const rawDefaultProfile = (rawOpencode as any).defaultProfile;
    const defaultProfile = typeof rawDefaultProfile === "string" ? rawDefaultProfile.trim() : "";

    if (enabled && profileNames.length === 0) {
      console.warn("[ralph] OpenCode profiles enabled but no valid profiles were configured; falling back to ambient XDG dirs");
      loaded.opencode = { enabled: false };
    } else if (!enabled) {
      loaded.opencode = { enabled: false };
    } else if (defaultProfile && profiles[defaultProfile]) {
      loaded.opencode = { enabled: true, defaultProfile, profiles };
    } else {
      const fallback = profileNames[0] ?? "";
      if (fallback) {
        if (defaultProfile) {
          console.warn(
            `[ralph] Invalid config opencode.defaultProfile=${JSON.stringify(defaultProfile)}; falling back to ${JSON.stringify(fallback)}`
          );
        }
        loaded.opencode = { enabled: true, defaultProfile: fallback, profiles };
      } else {
        loaded.opencode = { enabled: false };
      }
    }
  }

  // Best-effort validation for throttle config.
  const rawThrottle = (loaded as any).throttle;
  if (rawThrottle !== undefined && rawThrottle !== null && (typeof rawThrottle !== "object" || Array.isArray(rawThrottle))) {
    console.warn(`[ralph] Invalid config throttle=${JSON.stringify(rawThrottle)}; ignoring`);
    (loaded as any).throttle = undefined;
  } else if (rawThrottle && typeof rawThrottle === "object") {
    const throttleObj = rawThrottle as Record<string, unknown>;

    const enabledRaw = throttleObj.enabled;
    let enabled = true;
    if (enabledRaw !== undefined) {
      if (typeof enabledRaw === "boolean") {
        enabled = enabledRaw;
      } else {
        console.warn(`[ralph] Invalid config throttle.enabled=${JSON.stringify(enabledRaw)}; defaulting to true`);
        enabled = true;
      }
    }

    const providerRaw = throttleObj.providerID;
    let providerID = DEFAULT_THROTTLE_PROVIDER_ID;
    if (providerRaw !== undefined) {
      if (typeof providerRaw === "string" && providerRaw.trim()) {
        providerID = providerRaw.trim();
      } else {
        console.warn(
          `[ralph] Invalid config throttle.providerID=${JSON.stringify(providerRaw)}; defaulting to ${JSON.stringify(DEFAULT_THROTTLE_PROVIDER_ID)}`
        );
      }
    }

    const rawSoftPct = throttleObj.softPct;
    const rawHardPct = throttleObj.hardPct;

    const parsedSoftPct = rawSoftPct === undefined ? null : toPctOrNull(rawSoftPct);
    const parsedHardPct = rawHardPct === undefined ? null : toPctOrNull(rawHardPct);

    if (rawSoftPct !== undefined && parsedSoftPct == null) {
      console.warn(`[ralph] Invalid config throttle.softPct=${JSON.stringify(rawSoftPct)}; defaulting to ${DEFAULT_THROTTLE_SOFT_PCT}`);
    }
    if (rawHardPct !== undefined && parsedHardPct == null) {
      console.warn(`[ralph] Invalid config throttle.hardPct=${JSON.stringify(rawHardPct)}; defaulting to ${DEFAULT_THROTTLE_HARD_PCT}`);
    }

    let softPct = parsedSoftPct ?? DEFAULT_THROTTLE_SOFT_PCT;
    let hardPct = parsedHardPct ?? DEFAULT_THROTTLE_HARD_PCT;

    if (softPct > hardPct) {
      console.warn(
        `[ralph] Invalid config throttle softPct=${softPct} > hardPct=${hardPct}; ` +
          `defaulting to softPct=${DEFAULT_THROTTLE_SOFT_PCT}, hardPct=${DEFAULT_THROTTLE_HARD_PCT}`
      );
      softPct = DEFAULT_THROTTLE_SOFT_PCT;
      hardPct = DEFAULT_THROTTLE_HARD_PCT;
    }

    const rawMinCheck = throttleObj.minCheckIntervalMs;
    const parsedMinCheck = rawMinCheck === undefined ? null : toNonNegativeIntOrNull(rawMinCheck);
    if (rawMinCheck !== undefined && parsedMinCheck == null) {
      console.warn(
        `[ralph] Invalid config throttle.minCheckIntervalMs=${JSON.stringify(rawMinCheck)}; ` +
          `defaulting to ${DEFAULT_THROTTLE_MIN_CHECK_INTERVAL_MS}`
      );
    }
    const minCheckIntervalMs = parsedMinCheck ?? DEFAULT_THROTTLE_MIN_CHECK_INTERVAL_MS;

    const rawWindows = (throttleObj as any).windows;
    const windowsObj = rawWindows && typeof rawWindows === "object" && !Array.isArray(rawWindows) ? (rawWindows as any) : null;
    if (rawWindows !== undefined && windowsObj === null) {
      console.warn(`[ralph] Invalid config throttle.windows=${JSON.stringify(rawWindows)}; ignoring`);
    }

    const readBudgetOrDefault = (raw: unknown, label: string, fallback: number): number => {
      const budget = toPositiveIntOrNull(raw);
      if (budget) return budget;
      if (raw !== undefined) {
        console.warn(`[ralph] Invalid config ${label}=${JSON.stringify(raw)}; defaulting to ${fallback}`);
      }
      return fallback;
    };

    const budget5h = readBudgetOrDefault(
      windowsObj?.rolling5h?.budgetTokens,
      "throttle.windows.rolling5h.budgetTokens",
      DEFAULT_THROTTLE_BUDGET_5H_TOKENS
    );
    const budgetWeekly = readBudgetOrDefault(
      windowsObj?.weekly?.budgetTokens,
      "throttle.windows.weekly.budgetTokens",
      DEFAULT_THROTTLE_BUDGET_WEEKLY_TOKENS
    );

    const rawReset = (throttleObj as any).reset;
    const reset = rawReset && typeof rawReset === "object" && !Array.isArray(rawReset) ? (rawReset as any) : undefined;
    if (rawReset !== undefined && reset === undefined) {
      console.warn(`[ralph] Invalid config throttle.reset=${JSON.stringify(rawReset)}; ignoring`);
    }

    const rawPerProfile = (throttleObj as any).perProfile;
    let perProfile: Record<string, ThrottlePerProfileConfig> | undefined;

    if (rawPerProfile && typeof rawPerProfile === "object" && !Array.isArray(rawPerProfile)) {
      const out: Record<string, ThrottlePerProfileConfig> = {};

      for (const [rawName, rawOverride] of Object.entries(rawPerProfile as Record<string, unknown>)) {
        const name = String(rawName ?? "").trim();
        if (!name) continue;

        if (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride)) {
          console.warn(`[ralph] Invalid config throttle.perProfile.${name}=${JSON.stringify(rawOverride)}; skipping`);
          continue;
        }

        const o = rawOverride as Record<string, unknown>;
        const override: ThrottlePerProfileConfig = {};

        if (o.enabled !== undefined) {
          if (typeof o.enabled === "boolean") override.enabled = o.enabled;
          else console.warn(`[ralph] Invalid config throttle.perProfile.${name}.enabled=${JSON.stringify(o.enabled)}; ignoring`);
        }

        if (o.providerID !== undefined) {
          if (typeof o.providerID === "string" && o.providerID.trim()) override.providerID = o.providerID.trim();
          else console.warn(`[ralph] Invalid config throttle.perProfile.${name}.providerID=${JSON.stringify(o.providerID)}; ignoring`);
        }

        const ppSoftRaw = o.softPct;
        const ppHardRaw = o.hardPct;
        const ppSoft = ppSoftRaw === undefined ? null : toPctOrNull(ppSoftRaw);
        const ppHard = ppHardRaw === undefined ? null : toPctOrNull(ppHardRaw);

        if (ppSoftRaw !== undefined) {
          if (ppSoft == null) console.warn(`[ralph] Invalid config throttle.perProfile.${name}.softPct=${JSON.stringify(ppSoftRaw)}; ignoring`);
          else override.softPct = ppSoft;
        }

        if (ppHardRaw !== undefined) {
          if (ppHard == null) console.warn(`[ralph] Invalid config throttle.perProfile.${name}.hardPct=${JSON.stringify(ppHardRaw)}; ignoring`);
          else override.hardPct = ppHard;
        }

        if (typeof override.softPct === "number" && typeof override.hardPct === "number" && override.softPct > override.hardPct) {
          console.warn(`[ralph] Invalid config throttle.perProfile.${name} softPct>hardPct; ignoring both`);
          delete (override as any).softPct;
          delete (override as any).hardPct;
        }

        if (o.minCheckIntervalMs !== undefined) {
          const ms = toNonNegativeIntOrNull(o.minCheckIntervalMs);
          if (ms == null) {
            console.warn(
              `[ralph] Invalid config throttle.perProfile.${name}.minCheckIntervalMs=${JSON.stringify(o.minCheckIntervalMs)}; ignoring`
            );
          } else {
            override.minCheckIntervalMs = ms;
          }
        }

        const rawOverrideWindows = (o as any).windows;
        const overrideWindowsObj =
          rawOverrideWindows && typeof rawOverrideWindows === "object" && !Array.isArray(rawOverrideWindows)
            ? (rawOverrideWindows as any)
            : null;

        if (rawOverrideWindows !== undefined && overrideWindowsObj === null) {
          console.warn(`[ralph] Invalid config throttle.perProfile.${name}.windows=${JSON.stringify(rawOverrideWindows)}; ignoring`);
        } else if (overrideWindowsObj) {
          const w: { rolling5h?: ThrottleWindowConfig; weekly?: ThrottleWindowConfig } = {};

          const b5 = toPositiveIntOrNull(overrideWindowsObj?.rolling5h?.budgetTokens);
          if (overrideWindowsObj?.rolling5h?.budgetTokens !== undefined && !b5) {
            console.warn(
              `[ralph] Invalid config throttle.perProfile.${name}.windows.rolling5h.budgetTokens=` +
                `${JSON.stringify(overrideWindowsObj?.rolling5h?.budgetTokens)}; ignoring`
            );
          }
          if (b5) w.rolling5h = { budgetTokens: b5 };

          const bw = toPositiveIntOrNull(overrideWindowsObj?.weekly?.budgetTokens);
          if (overrideWindowsObj?.weekly?.budgetTokens !== undefined && !bw) {
            console.warn(
              `[ralph] Invalid config throttle.perProfile.${name}.windows.weekly.budgetTokens=` +
                `${JSON.stringify(overrideWindowsObj?.weekly?.budgetTokens)}; ignoring`
            );
          }
          if (bw) w.weekly = { budgetTokens: bw };

          if (w.rolling5h || w.weekly) override.windows = w;
        }

        if (Object.keys(override).length > 0) out[name] = override;
      }

      if (Object.keys(out).length > 0) perProfile = out;
    } else if (rawPerProfile !== undefined) {
      console.warn(`[ralph] Invalid config throttle.perProfile=${JSON.stringify(rawPerProfile)}; ignoring`);
    }

    loaded.throttle = {
      enabled,
      providerID,
      softPct,
      hardPct,
      minCheckIntervalMs,
      windows: {
        rolling5h: { budgetTokens: budget5h },
        weekly: { budgetTokens: budgetWeekly },
      },
      ...(reset ? { reset } : {}),
      ...(perProfile ? { perProfile } : {}),
    };
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

export type ResolvedOpencodeProfile = {
  name: string;
  xdgDataHome: string;
  xdgConfigHome: string;
  xdgStateHome: string;
  xdgCacheHome?: string;
};

export function isOpencodeProfilesEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.opencode?.enabled ?? false;
}

export function listOpencodeProfileNames(): string[] {
  const cfg = loadConfig();
  const profiles = cfg.opencode?.profiles;
  if (!profiles || typeof profiles !== "object") return [];
  return Object.keys(profiles).sort();
}

export function getOpencodeDefaultProfileName(): string | null {
  const cfg = loadConfig();
  const raw = cfg.opencode?.defaultProfile;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

export function resolveOpencodeProfile(name?: string | null): ResolvedOpencodeProfile | null {
  const cfg = loadConfig();
  const opencode = cfg.opencode;
  if (!opencode?.enabled) return null;

  const profiles = opencode.profiles;
  if (!profiles) return null;

  const rawName = (name ?? opencode.defaultProfile ?? "").trim();
  if (!rawName) return null;

  const profile = profiles[rawName];
  if (!profile) return null;

  return { name: rawName, ...profile };
}
