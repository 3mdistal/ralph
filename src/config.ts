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
   * Required status checks for merge gating (default: derive from branch protection).
   *
   * Values must match the check context name shown by GitHub.
   * Set to [] to disable merge gating for a repo.
   * When omitted, Ralph derives required checks from GitHub branch protection on the bot branch,
   * falling back to the repo default branch. Missing/unreadable protection disables gating.
   */
  requiredChecks?: string[];
  /**
   * Optional per-repo setup commands run in the task worktree before any agent execution.
   * Commands are operator-owned and defined in ~/.ralph/config.toml|json.
   */
  setup?: string[];
  /** Per-repo concurrency slots for this repo (default: 1). */
  concurrencySlots?: number;
  /** Max concurrent tasks for this repo (default: 1). Deprecated: use concurrencySlots. */
  maxWorkers?: number;
  /** PRs before rollup for this repo (defaults to global batchSize) */
  rollupBatchSize?: number;
  /** Enable proactive update-branch when a PR is BEHIND (default: false). */
  autoUpdateBehindPrs?: boolean;
  /** Optional label gate for proactive update-branch (default: none). */
  autoUpdateBehindLabel?: string;
  /** Minimum minutes between proactive updates per PR (default: 30). */
  autoUpdateBehindMinMinutes?: number;
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
  /** IANA time zone, e.g. "America/Indiana/Indianapolis" (default: system local time zone). */
  timeZone?: string;
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
  reset?: {
    rolling5h?: ThrottleResetRolling5hConfig;
    weekly?: ThrottleResetWeeklyConfig;
  };
}

export interface ThrottleConfig {
  /** Enable usage-based throttling (default: true). */
  enabled?: boolean;
  /** Provider ID to count toward usage (default: "openai"). */
  providerID?: string;
  /** OpenAI throttle source (default: "remoteUsage"). */
  openaiSource?: "localLogs" | "remoteUsage";
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
  /** Optional managed OpenCode config dir for daemon runs (absolute path). */
  managedConfigDir?: string;
}

export interface ControlConfig {
  /** Auto-create control.json when missing (default: true). */
  autoCreate?: boolean;
  /** Suppress missing control.json warnings (default: true). */
  suppressMissingWarnings?: boolean;
}

export class RalphConfigError extends Error {
  readonly code: "RALPH_CONFIG_INVALID" | "RALPH_CONFIG_SANDBOX_INVALID";

  constructor(code: "RALPH_CONFIG_INVALID" | "RALPH_CONFIG_SANDBOX_INVALID", message: string) {
    super(message);
    this.name = "RalphConfigError";
    this.code = code;
  }
}

export type RalphProfile = "prod" | "sandbox";

export interface SandboxGithubAuthConfig {
  githubApp?: {
    appId: number | string;
    installationId: number | string;
    /** PEM file path (read at runtime; never log key material). */
    privateKeyPath: string;
  };
  /** Env var name for a fine-grained PAT restricted to sandbox repos. */
  tokenEnvVar?: string;
}

export interface SandboxRetentionConfig {
  /** Keep the last N sandbox run repos (default: 10). */
  keepLast?: number;
  /** Keep failed sandbox run repos for N days (default: 14). */
  keepFailedDays?: number;
}

export interface SandboxProfileConfig {
  /** Allowed repo owners for sandbox runs (non-empty). */
  allowedOwners: string[];
  /** Required repo name prefix for sandbox repos. */
  repoNamePrefix: string;
  /** Dedicated GitHub auth for sandbox runs. */
  githubAuth: SandboxGithubAuthConfig;
  /** Optional retention policy for sandbox run repos. */
  retention?: SandboxRetentionConfig;
  /** Optional sandbox provisioning configuration. */
  provisioning?: SandboxProvisioningConfig;
}

export type SandboxProvisioningSettingsPreset = "minimal" | "parity";

export type SandboxProvisioningSeedConfig =
  | { preset: "baseline"; file?: undefined }
  | { file: string; preset?: undefined };

export interface SandboxProvisioningConfig {
  templateRepo: string;
  templateRef?: string;
  repoVisibility?: "private";
  settingsPreset?: SandboxProvisioningSettingsPreset;
  seed?: SandboxProvisioningSeedConfig;
}

export interface DashboardConfig {
  /** Days to retain dashboard event logs (default: 14). */
  eventsRetentionDays?: number;
}

export type QueueBackend = "github" | "bwrb" | "none";

export interface RalphConfig {
  repos: RepoConfig[];
  /** Global max concurrent tasks across all repos (default: 6) */
  maxWorkers: number;
  batchSize: number;       // PRs before rollup (default: 10)
  pollInterval: number;    // ms between queue checks when polling (default: 30000)
  /** ms between done reconciliation checks (default: 300000) */
  doneReconcileIntervalMs: number;
  /** Ownership TTL in ms for task heartbeats (default: 60000). */
  ownershipTtlMs: number;
  /** Queue backend selection (default: "github"). */
  queueBackend?: QueueBackend;
  bwrbVault: string;       // path to bwrb vault for queue
  owner: string;           // default GitHub owner (default: "3mdistal")

  /** Runtime profile for safety rails (default: "prod"). */
  profile?: RalphProfile;
  /** Sandbox profile configuration (required when profile="sandbox"). */
  sandbox?: SandboxProfileConfig;

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
  control?: ControlConfig;
  dashboard?: DashboardConfig;
}

const DEFAULT_GLOBAL_MAX_WORKERS = 6;
const DEFAULT_REPO_MAX_WORKERS = 1;
const DEFAULT_REPO_CONCURRENCY_SLOTS = DEFAULT_REPO_MAX_WORKERS;
const DEFAULT_OWNERSHIP_TTL_MS = 60_000;
const DEFAULT_DONE_RECONCILE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_AUTO_UPDATE_BEHIND_MIN_MINUTES = 30;

const DEFAULT_THROTTLE_PROVIDER_ID = "openai";
const DEFAULT_THROTTLE_OPENAI_SOURCE: "localLogs" | "remoteUsage" = "remoteUsage";
const DEFAULT_THROTTLE_SOFT_PCT = 0.65;
const DEFAULT_THROTTLE_HARD_PCT = 0.75;
const DEFAULT_THROTTLE_MIN_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_THROTTLE_BUDGET_5H_TOKENS = 16_987_015;
const DEFAULT_THROTTLE_BUDGET_WEEKLY_TOKENS = 55_769_305;
const DEFAULT_DASHBOARD_EVENTS_RETENTION_DAYS = 14;
const DEFAULT_SANDBOX_KEEP_LAST = 10;
const DEFAULT_SANDBOX_KEEP_FAILED_DAYS = 14;

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

export function checkBwrbVaultLayout(vault: string): { ok: boolean; error?: string } {
  if (!vault || !existsSync(vault)) {
    return {
      ok: false,
      error:
        `[ralph] bwrbVault is missing or invalid: ${JSON.stringify(vault)}. ` +
        `Set it in ~/.ralph/config.toml or ~/.ralph/config.json (key: bwrbVault).`,
    };
  }

  const schemaPath = join(vault, ".bwrb", "schema.json");
  if (!existsSync(schemaPath)) {
    return {
      ok: false,
      error:
        `[ralph] bwrbVault does not contain a bwrb schema: ${JSON.stringify(vault)} (missing ${schemaPath}). ` +
        `Point bwrbVault at a directory that contains .bwrb/schema.json.`,
    };
  }

  return { ok: true };
}

export function ensureBwrbVaultLayout(vault: string): boolean {
  const check = checkBwrbVaultLayout(vault);
  if (!check.ok) {
    console.error(check.error ?? `[ralph] bwrbVault is missing or invalid: ${JSON.stringify(vault)}.`);
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
  doneReconcileIntervalMs: DEFAULT_DONE_RECONCILE_INTERVAL_MS,
  ownershipTtlMs: DEFAULT_OWNERSHIP_TTL_MS,
  queueBackend: "github",
  bwrbVault: detectDefaultBwrbVault(),
  owner: "3mdistal",
  devDir: join(homedir(), "Developer"),
  profile: "prod",
};

type ConfigSource = "default" | "toml" | "json" | "legacy";

export type ConfigMeta = {
  source: ConfigSource;
  queueBackendExplicit: boolean;
  queueBackendRaw?: unknown;
  queueBackendValid: boolean;
};

export type ConfigLoadResult = {
  config: RalphConfig;
  meta: ConfigMeta;
};

let configResult: ConfigLoadResult | null = null;

function isQueueBackendValue(value: unknown): value is QueueBackend {
  return value === "github" || value === "bwrb" || value === "none";
}

function toPositiveIntOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value <= 0) return null;
  return value;
}

function toPositiveIntFromUnknownOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0) return null;
  return n;
}

function toNonEmptyStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

  const ownershipTtlMs = toPositiveIntOrNull((loaded as any).ownershipTtlMs);
  if (!ownershipTtlMs) {
    const raw = (loaded as any).ownershipTtlMs;
    if (raw !== undefined) {
      console.warn(
        `[ralph] Invalid config ownershipTtlMs=${JSON.stringify(raw)}; falling back to default ${DEFAULT_OWNERSHIP_TTL_MS}`
      );
    }
    loaded.ownershipTtlMs = DEFAULT_OWNERSHIP_TTL_MS;
  }

  const doneInterval = toPositiveIntOrNull((loaded as any).doneReconcileIntervalMs);
  if (!doneInterval) {
    const raw = (loaded as any).doneReconcileIntervalMs;
    if (raw !== undefined) {
      console.warn(
        `[ralph] Invalid config doneReconcileIntervalMs=${JSON.stringify(raw)}; falling back to default ${DEFAULT_DONE_RECONCILE_INTERVAL_MS}`
      );
    }
    loaded.doneReconcileIntervalMs = DEFAULT_DONE_RECONCILE_INTERVAL_MS;
  }

  const rawQueueBackend = (loaded as any).queueBackend;
  if (rawQueueBackend !== undefined) {
    if (isQueueBackendValue(rawQueueBackend)) {
      loaded.queueBackend = rawQueueBackend;
    } else {
      console.warn(
        `[ralph] Invalid config queueBackend=${JSON.stringify(rawQueueBackend)}; falling back to "github"`
      );
      loaded.queueBackend = "github";
    }
  } else if (!loaded.queueBackend) {
    loaded.queueBackend = "github";
  }

  const rawProfile = (loaded as any).profile;
  if (rawProfile === undefined || rawProfile === null || rawProfile === "") {
    loaded.profile = "prod";
  } else if (rawProfile === "prod" || rawProfile === "sandbox") {
    loaded.profile = rawProfile;
  } else {
    throw new RalphConfigError(
      "RALPH_CONFIG_INVALID",
      `[ralph] Invalid config profile=${JSON.stringify(rawProfile)}; expected "prod" or "sandbox".`
    );
  }

  // Validate per-repo concurrencySlots/maxWorkers + rollupBatchSize. We keep them optional in the config, but sanitize invalid values.
  loaded.repos = (loaded.repos ?? []).map((repo) => {
    const mw = toPositiveIntOrNull((repo as any).maxWorkers);
    const slots = toPositiveIntOrNull((repo as any).concurrencySlots);
    const rollupBatch = toPositiveIntOrNull((repo as any).rollupBatchSize);
    const autoUpdateMin = toPositiveIntOrNull((repo as any).autoUpdateBehindMinMinutes);
    const updates: Partial<RepoConfig> = {};

    if ((repo as any).concurrencySlots !== undefined && !slots) {
      console.warn(
        `[ralph] Invalid config concurrencySlots for repo ${repo.name}: ${JSON.stringify((repo as any).concurrencySlots)}; ` +
          `falling back to default ${DEFAULT_REPO_CONCURRENCY_SLOTS}`
      );
      updates.concurrencySlots = DEFAULT_REPO_CONCURRENCY_SLOTS;
    }

    if ((repo as any).maxWorkers !== undefined && !mw) {
      console.warn(
        `[ralph] Invalid config maxWorkers for repo ${repo.name}: ${JSON.stringify((repo as any).maxWorkers)}; ` +
          `falling back to default ${DEFAULT_REPO_MAX_WORKERS}`
      );
      updates.maxWorkers = DEFAULT_REPO_MAX_WORKERS;
    }

    if ((repo as any).rollupBatchSize !== undefined && !rollupBatch) {
      console.warn(
        `[ralph] Invalid config rollupBatchSize for repo ${repo.name}: ${JSON.stringify((repo as any).rollupBatchSize)}; ` +
          `falling back to global batchSize`
      );
      updates.rollupBatchSize = undefined;
    }

    const rawAutoUpdate = (repo as any).autoUpdateBehindPrs;
    if (rawAutoUpdate !== undefined && typeof rawAutoUpdate !== "boolean") {
      console.warn(
        `[ralph] Invalid config autoUpdateBehindPrs for repo ${repo.name}: ${JSON.stringify(rawAutoUpdate)}; ` +
          `defaulting to false`
      );
      updates.autoUpdateBehindPrs = false;
    }

    const rawLabelGate = (repo as any).autoUpdateBehindLabel;
    if (rawLabelGate !== undefined) {
      if (typeof rawLabelGate === "string" && rawLabelGate.trim()) {
        updates.autoUpdateBehindLabel = rawLabelGate.trim();
      } else {
        console.warn(
          `[ralph] Invalid config autoUpdateBehindLabel for repo ${repo.name}: ${JSON.stringify(rawLabelGate)}; ` +
            `disabling label gate`
        );
        updates.autoUpdateBehindLabel = undefined;
      }
    }

    if ((repo as any).autoUpdateBehindMinMinutes !== undefined && !autoUpdateMin) {
      console.warn(
        `[ralph] Invalid config autoUpdateBehindMinMinutes for repo ${repo.name}: ` +
          `${JSON.stringify((repo as any).autoUpdateBehindMinMinutes)}; falling back to ${DEFAULT_AUTO_UPDATE_BEHIND_MIN_MINUTES}`
      );
      updates.autoUpdateBehindMinMinutes = DEFAULT_AUTO_UPDATE_BEHIND_MIN_MINUTES;
    }

    if (Object.keys(updates).length === 0) return repo;
    return { ...repo, ...updates };
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

  if (loaded.profile === "sandbox") {
    const rawSandbox = (loaded as any).sandbox;
    if (!rawSandbox || typeof rawSandbox !== "object" || Array.isArray(rawSandbox)) {
      throw new RalphConfigError(
        "RALPH_CONFIG_SANDBOX_INVALID",
        "[ralph] Sandbox profile requires a sandbox config block."
      );
    }

    const allowedOwners = toStringArrayOrNull((rawSandbox as any).allowedOwners);
    if (!allowedOwners || allowedOwners.length === 0) {
      throw new RalphConfigError(
        "RALPH_CONFIG_SANDBOX_INVALID",
        "[ralph] Sandbox profile requires sandbox.allowedOwners (non-empty array)."
      );
    }

    const repoNamePrefix = toNonEmptyStringOrNull((rawSandbox as any).repoNamePrefix);
    if (!repoNamePrefix) {
      throw new RalphConfigError(
        "RALPH_CONFIG_SANDBOX_INVALID",
        "[ralph] Sandbox profile requires sandbox.repoNamePrefix (non-empty string)."
      );
    }

    const rawGithubAuth = (rawSandbox as any).githubAuth;
    if (!rawGithubAuth || typeof rawGithubAuth !== "object" || Array.isArray(rawGithubAuth)) {
      throw new RalphConfigError(
        "RALPH_CONFIG_SANDBOX_INVALID",
        "[ralph] Sandbox profile requires sandbox.githubAuth with githubApp or tokenEnvVar."
      );
    }

    const rawSandboxApp = (rawGithubAuth as any).githubApp;
    const tokenEnvVar = toNonEmptyStringOrNull((rawGithubAuth as any).tokenEnvVar) ?? undefined;

    let hasValidApp = false;
    if (rawSandboxApp && typeof rawSandboxApp === "object" && !Array.isArray(rawSandboxApp)) {
      const appId = toPositiveIntFromUnknownOrNull((rawSandboxApp as any).appId);
      const installationId = toPositiveIntFromUnknownOrNull((rawSandboxApp as any).installationId);
      const privateKeyPath = toNonEmptyStringOrNull((rawSandboxApp as any).privateKeyPath);
      hasValidApp = Boolean(appId && installationId && privateKeyPath);
      if (!hasValidApp) {
        throw new RalphConfigError(
          "RALPH_CONFIG_SANDBOX_INVALID",
          "[ralph] Sandbox githubAuth.githubApp is invalid; expected { appId, installationId, privateKeyPath }."
        );
      }
    }

    if (!hasValidApp && !tokenEnvVar) {
      throw new RalphConfigError(
        "RALPH_CONFIG_SANDBOX_INVALID",
        "[ralph] Sandbox profile requires githubAuth.githubApp or githubAuth.tokenEnvVar."
      );
    }

    if (!hasValidApp && tokenEnvVar) {
      const tokenValue = process.env[tokenEnvVar];
      if (!tokenValue || !tokenValue.trim()) {
        throw new RalphConfigError(
          "RALPH_CONFIG_SANDBOX_INVALID",
          `[ralph] Sandbox githubAuth.tokenEnvVar is set but ${tokenEnvVar} is missing/empty.`
        );
      }
    }

    let retention: SandboxRetentionConfig | undefined;
    const rawRetention = (rawSandbox as any).retention;
    if (rawRetention !== undefined) {
      if (!rawRetention || typeof rawRetention !== "object" || Array.isArray(rawRetention)) {
        console.warn(`[ralph] Invalid config sandbox.retention=${JSON.stringify(rawRetention)}; ignoring`);
      } else {
        const keepLast = toNonNegativeIntOrNull((rawRetention as any).keepLast);
        const keepFailedDays = toNonNegativeIntOrNull((rawRetention as any).keepFailedDays);
        if ((rawRetention as any).keepLast !== undefined && keepLast === null) {
          console.warn(
            `[ralph] Invalid config sandbox.retention.keepLast=${JSON.stringify((rawRetention as any).keepLast)}; ignoring`
          );
        }
        if ((rawRetention as any).keepFailedDays !== undefined && keepFailedDays === null) {
          console.warn(
            `[ralph] Invalid config sandbox.retention.keepFailedDays=${JSON.stringify(
              (rawRetention as any).keepFailedDays
            )}; ignoring`
          );
        }
        if (keepLast !== null || keepFailedDays !== null) {
          retention = {
            ...(keepLast !== null ? { keepLast } : {}),
            ...(keepFailedDays !== null ? { keepFailedDays } : {}),
          };
        }
      }
    }

    let provisioning: SandboxProvisioningConfig | undefined;
    const rawProvisioning = (rawSandbox as any).provisioning;
    if (rawProvisioning !== undefined) {
      if (!rawProvisioning || typeof rawProvisioning !== "object" || Array.isArray(rawProvisioning)) {
        throw new RalphConfigError(
          "RALPH_CONFIG_SANDBOX_INVALID",
          "[ralph] Sandbox provisioning must be an object when provided."
        );
      }

      const templateRepo = toNonEmptyStringOrNull((rawProvisioning as any).templateRepo);
      if (!templateRepo) {
        throw new RalphConfigError(
          "RALPH_CONFIG_SANDBOX_INVALID",
          "[ralph] Sandbox provisioning requires provisioning.templateRepo (non-empty string)."
        );
      }

      const templateRef = toNonEmptyStringOrNull((rawProvisioning as any).templateRef) ?? "main";
      const repoVisibility = toNonEmptyStringOrNull((rawProvisioning as any).repoVisibility) ?? "private";
      if (repoVisibility !== "private") {
        throw new RalphConfigError(
          "RALPH_CONFIG_SANDBOX_INVALID",
          "[ralph] Sandbox provisioning repoVisibility must be \"private\"."
        );
      }

      const settingsPreset =
        (toNonEmptyStringOrNull((rawProvisioning as any).settingsPreset) as SandboxProvisioningSettingsPreset | null) ??
        "minimal";
      if (settingsPreset !== "minimal" && settingsPreset !== "parity") {
        throw new RalphConfigError(
          "RALPH_CONFIG_SANDBOX_INVALID",
          "[ralph] Sandbox provisioning settingsPreset must be \"minimal\" or \"parity\"."
        );
      }

      const rawSeed = (rawProvisioning as any).seed;
      let seed: SandboxProvisioningSeedConfig | undefined;
      if (rawSeed !== undefined) {
        if (!rawSeed || typeof rawSeed !== "object" || Array.isArray(rawSeed)) {
          throw new RalphConfigError(
            "RALPH_CONFIG_SANDBOX_INVALID",
            "[ralph] Sandbox provisioning seed must be an object."
          );
        }
        const preset = toNonEmptyStringOrNull((rawSeed as any).preset);
        const file = toNonEmptyStringOrNull((rawSeed as any).file);

        if (preset && file) {
          throw new RalphConfigError(
            "RALPH_CONFIG_SANDBOX_INVALID",
            "[ralph] Sandbox provisioning seed cannot set both preset and file."
          );
        }
        if (preset) {
          if (preset !== "baseline") {
            throw new RalphConfigError(
              "RALPH_CONFIG_SANDBOX_INVALID",
              "[ralph] Sandbox provisioning seed preset must be \"baseline\"."
            );
          }
          seed = { preset: "baseline" };
        } else if (file) {
          if (!isAbsolute(file)) {
            throw new RalphConfigError(
              "RALPH_CONFIG_SANDBOX_INVALID",
              "[ralph] Sandbox provisioning seed file must be an absolute path."
            );
          }
          seed = { file };
        } else {
          throw new RalphConfigError(
            "RALPH_CONFIG_SANDBOX_INVALID",
            "[ralph] Sandbox provisioning seed must include preset or file."
          );
        }
      }

      provisioning = {
        templateRepo,
        templateRef,
        repoVisibility: "private",
        settingsPreset,
        seed,
      };
    }

    loaded.sandbox = {
      allowedOwners,
      repoNamePrefix,
      githubAuth: {
        ...(hasValidApp ? { githubApp: rawSandboxApp } : {}),
        ...(tokenEnvVar ? { tokenEnvVar } : {}),
      },
      ...(retention ? { retention } : {}),
      ...(provisioning ? { provisioning } : {}),
    };
  }

  // Best-effort validation for GitHub App auth config.
  const rawGithubApp = (loaded as any).githubApp;
  if (rawGithubApp !== undefined && rawGithubApp !== null && typeof rawGithubApp !== "object") {
    console.warn(`[ralph] Invalid config githubApp=${JSON.stringify(rawGithubApp)}; ignoring`);
    (loaded as any).githubApp = undefined;
  }

  // Best-effort validation for control file config.
  const rawControl = (loaded as any).control;
  if (rawControl !== undefined && rawControl !== null && (typeof rawControl !== "object" || Array.isArray(rawControl))) {
    console.warn(`[ralph] Invalid config control=${JSON.stringify(rawControl)}; ignoring`);
    (loaded as any).control = undefined;
  } else if (rawControl && typeof rawControl === "object") {
    const autoCreateRaw = (rawControl as any).autoCreate;
    const suppressMissingWarningsRaw = (rawControl as any).suppressMissingWarnings;
    const next: ControlConfig = {};

    if (autoCreateRaw !== undefined) {
      if (typeof autoCreateRaw === "boolean") {
        next.autoCreate = autoCreateRaw;
      } else {
        console.warn(`[ralph] Invalid config control.autoCreate=${JSON.stringify(autoCreateRaw)}; defaulting to true`);
        next.autoCreate = true;
      }
    }

    if (suppressMissingWarningsRaw !== undefined) {
      if (typeof suppressMissingWarningsRaw === "boolean") {
        next.suppressMissingWarnings = suppressMissingWarningsRaw;
      } else {
        console.warn(
          `[ralph] Invalid config control.suppressMissingWarnings=${JSON.stringify(suppressMissingWarningsRaw)}; defaulting to true`
        );
        next.suppressMissingWarnings = true;
      }
    }

    if (Object.keys(next).length > 0) {
      loaded.control = next;
    } else {
      loaded.control = undefined;
    }
  }

  // Best-effort validation for dashboard config.
  const rawDashboard = (loaded as any).dashboard;
  if (rawDashboard !== undefined && rawDashboard !== null && (typeof rawDashboard !== "object" || Array.isArray(rawDashboard))) {
    console.warn(`[ralph] Invalid config dashboard=${JSON.stringify(rawDashboard)}; ignoring`);
    (loaded as any).dashboard = undefined;
  } else if (rawDashboard && typeof rawDashboard === "object") {
    const rawRetention = (rawDashboard as any).eventsRetentionDays;
    const parsedRetention = rawRetention === undefined ? null : toPositiveIntOrNull(rawRetention);
    if (rawRetention !== undefined && parsedRetention == null) {
      console.warn(
        `[ralph] Invalid config dashboard.eventsRetentionDays=${JSON.stringify(rawRetention)}; ` +
          `defaulting to ${DEFAULT_DASHBOARD_EVENTS_RETENTION_DAYS}`
      );
    }
    const retention = parsedRetention ?? DEFAULT_DASHBOARD_EVENTS_RETENTION_DAYS;
    loaded.dashboard = { eventsRetentionDays: retention };
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

    const rawManagedConfigDir = (rawOpencode as any).managedConfigDir;
    let managedConfigDir: string | undefined;
    if (rawManagedConfigDir !== undefined) {
      if (typeof rawManagedConfigDir === "string" && rawManagedConfigDir.trim()) {
        const trimmed = rawManagedConfigDir.trim();
        if (!isAbsolute(trimmed)) {
          console.warn(
            `[ralph] Invalid config opencode.managedConfigDir=${JSON.stringify(trimmed)}; must be an absolute path. Ignoring.`
          );
        } else {
          managedConfigDir = trimmed;
        }
      } else {
        console.warn(`[ralph] Invalid config opencode.managedConfigDir=${JSON.stringify(rawManagedConfigDir)}; ignoring`);
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

    const attachManaged = (opencode: OpencodeConfig): OpencodeConfig =>
      managedConfigDir ? { ...opencode, managedConfigDir } : opencode;

    if (enabled && profileNames.length === 0) {
      console.warn("[ralph] OpenCode profiles enabled but no valid profiles were configured; falling back to ambient XDG dirs");
      loaded.opencode = attachManaged({ enabled: false });
    } else if (!enabled) {
      loaded.opencode = attachManaged({ enabled: false });
    } else if (defaultProfile && profiles[defaultProfile]) {
      loaded.opencode = attachManaged({ enabled: true, defaultProfile, profiles });
    } else {
      const fallback = profileNames[0] ?? "";
      if (fallback) {
        if (defaultProfile) {
          console.warn(
            `[ralph] Invalid config opencode.defaultProfile=${JSON.stringify(defaultProfile)}; falling back to ${JSON.stringify(fallback)}`
          );
        }
        loaded.opencode = attachManaged({ enabled: true, defaultProfile: fallback, profiles });
      } else {
        loaded.opencode = attachManaged({ enabled: false });
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

    const openaiSourceRaw = throttleObj.openaiSource;
    let openaiSource: "localLogs" | "remoteUsage" = DEFAULT_THROTTLE_OPENAI_SOURCE;
    if (openaiSourceRaw !== undefined) {
      if (openaiSourceRaw === "localLogs" || openaiSourceRaw === "remoteUsage") {
        openaiSource = openaiSourceRaw;
      } else {
        console.warn(
          `[ralph] Invalid config throttle.openaiSource=${JSON.stringify(openaiSourceRaw)}; defaulting to ${JSON.stringify(DEFAULT_THROTTLE_OPENAI_SOURCE)}`
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

    const isValidTimeZone = (tz: string): boolean => {
      try {
        // eslint-disable-next-line no-new
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
        return true;
      } catch {
        return false;
      }
    };

    const parseResetRolling5h = (raw: any, label: string): ThrottleResetRolling5hConfig | undefined => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const obj = raw as Record<string, unknown>;

      const out: ThrottleResetRolling5hConfig = {};

      if (obj.hours !== undefined) {
        if (Array.isArray(obj.hours)) {
          const hours = obj.hours
            .map((h) => toNonNegativeIntOrNull(h))
            .filter((h): h is number => typeof h === "number" && h >= 0 && h <= 23);
          if (hours.length > 0) out.hours = Array.from(new Set(hours)).sort((a, b) => a - b);
          else console.warn(`[ralph] Invalid config ${label}.hours=${JSON.stringify(obj.hours)}; ignoring`);
        } else {
          console.warn(`[ralph] Invalid config ${label}.hours=${JSON.stringify(obj.hours)}; ignoring`);
        }
      }

      if (obj.minute !== undefined) {
        const minute = toNonNegativeIntOrNull(obj.minute);
        if (minute == null || minute > 59) {
          console.warn(`[ralph] Invalid config ${label}.minute=${JSON.stringify(obj.minute)}; ignoring`);
        } else {
          out.minute = minute;
        }
      }

      return Object.keys(out).length > 0 ? out : undefined;
    };

    const parseResetWeekly = (raw: any, label: string): ThrottleResetWeeklyConfig | undefined => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const obj = raw as Record<string, unknown>;

      const out: ThrottleResetWeeklyConfig = {};

      if (obj.dayOfWeek !== undefined) {
        const day = toNonNegativeIntOrNull(obj.dayOfWeek);
        if (day == null || day > 6) {
          console.warn(`[ralph] Invalid config ${label}.dayOfWeek=${JSON.stringify(obj.dayOfWeek)}; ignoring`);
        } else {
          out.dayOfWeek = day;
        }
      }

      if (obj.hour !== undefined) {
        const hour = toNonNegativeIntOrNull(obj.hour);
        if (hour == null || hour > 23) {
          console.warn(`[ralph] Invalid config ${label}.hour=${JSON.stringify(obj.hour)}; ignoring`);
        } else {
          out.hour = hour;
        }
      }

      if (obj.minute !== undefined) {
        const minute = toNonNegativeIntOrNull(obj.minute);
        if (minute == null || minute > 59) {
          console.warn(`[ralph] Invalid config ${label}.minute=${JSON.stringify(obj.minute)}; ignoring`);
        } else {
          out.minute = minute;
        }
      }

      if (obj.timeZone !== undefined) {
        if (typeof obj.timeZone === "string" && obj.timeZone.trim()) {
          const tz = obj.timeZone.trim();
          if (isValidTimeZone(tz)) out.timeZone = tz;
          else console.warn(`[ralph] Invalid config ${label}.timeZone=${JSON.stringify(obj.timeZone)}; ignoring`);
        } else {
          console.warn(`[ralph] Invalid config ${label}.timeZone=${JSON.stringify(obj.timeZone)}; ignoring`);
        }
      }

      return Object.keys(out).length > 0 ? out : undefined;
    };

    const rawReset = (throttleObj as any).reset;
    const resetObj = rawReset && typeof rawReset === "object" && !Array.isArray(rawReset) ? (rawReset as any) : undefined;
    if (rawReset !== undefined && resetObj === undefined) {
      console.warn(`[ralph] Invalid config throttle.reset=${JSON.stringify(rawReset)}; ignoring`);
    }

    const resetRolling5h = parseResetRolling5h(resetObj?.rolling5h, "throttle.reset.rolling5h");
    const resetWeekly = parseResetWeekly(resetObj?.weekly, "throttle.reset.weekly");

    const resetCfg = resetRolling5h || resetWeekly ? { ...(resetRolling5h ? { rolling5h: resetRolling5h } : {}), ...(resetWeekly ? { weekly: resetWeekly } : {}) } : undefined;

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

        const rawOverrideReset = (o as any).reset;
        const overrideResetObj =
          rawOverrideReset && typeof rawOverrideReset === "object" && !Array.isArray(rawOverrideReset) ? (rawOverrideReset as any) : undefined;

        if (rawOverrideReset !== undefined && overrideResetObj === undefined) {
          console.warn(`[ralph] Invalid config throttle.perProfile.${name}.reset=${JSON.stringify(rawOverrideReset)}; ignoring`);
        }

        const overrideResetRolling5h = parseResetRolling5h(overrideResetObj?.rolling5h, `throttle.perProfile.${name}.reset.rolling5h`);
        const overrideResetWeekly = parseResetWeekly(overrideResetObj?.weekly, `throttle.perProfile.${name}.reset.weekly`);

        if (overrideResetRolling5h || overrideResetWeekly) {
          override.reset = {
            ...(overrideResetRolling5h ? { rolling5h: overrideResetRolling5h } : {}),
            ...(overrideResetWeekly ? { weekly: overrideResetWeekly } : {}),
          };
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
      openaiSource,
      softPct,
      hardPct,
      minCheckIntervalMs,
      windows: {
        rolling5h: { budgetTokens: budget5h },
        weekly: { budgetTokens: budgetWeekly },
      },
      ...(resetCfg ? { reset: resetCfg } : {}),
      ...(perProfile ? { perProfile } : {}),
    };
  }

  return loaded;
}

export function loadConfig(): ConfigLoadResult {
  if (configResult) return configResult;

  // Start with defaults
  let loaded: RalphConfig = { ...DEFAULT_CONFIG };
  let meta: ConfigMeta = {
    source: "default",
    queueBackendExplicit: false,
    queueBackendRaw: undefined,
    queueBackendValid: true,
  };

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

  const recordConfigSource = (source: ConfigSource, fileConfig: any | null) => {
    const hasQueueBackend = Boolean(fileConfig && Object.prototype.hasOwnProperty.call(fileConfig, "queueBackend"));
    const queueBackendRaw = hasQueueBackend ? fileConfig.queueBackend : undefined;
    meta = {
      source,
      queueBackendExplicit: hasQueueBackend,
      queueBackendRaw,
      queueBackendValid: !hasQueueBackend || isQueueBackendValue(queueBackendRaw),
    };
  };

  if (existsSync(configTomlPath)) {
    const fileConfig = tryLoadToml(configTomlPath);
    if (fileConfig) {
      loaded = { ...loaded, ...fileConfig };
      recordConfigSource("toml", fileConfig);
    }
  } else if (existsSync(configJsonPath)) {
    const fileConfig = tryLoadJson(configJsonPath);
    if (fileConfig) {
      loaded = { ...loaded, ...fileConfig };
      recordConfigSource("json", fileConfig);
    }
  } else if (existsSync(legacyConfigPath)) {
    console.warn(
      `[ralph] Using legacy config path ${legacyConfigPath}. ` +
        `Migrate to ${configTomlPath} or ${configJsonPath} (preferred).`
    );

    const fileConfig = tryLoadJson(legacyConfigPath);
    if (fileConfig) {
      loaded = { ...loaded, ...fileConfig };
      recordConfigSource("legacy", fileConfig);
    }
  }

  configResult = {
    config: validateConfig(loaded),
    meta,
  };
  return configResult;
}

export function __resetConfigForTests(): void {
  configResult = null;
}

export function getConfigSource(): ConfigSource {
  return loadConfig().meta.source;
}

export function getConfigMeta(): ConfigMeta {
  return loadConfig().meta;
}

export function isQueueBackendExplicit(): boolean {
  return loadConfig().meta.queueBackendExplicit;
}

export function getConfig(): RalphConfig {
  return loadConfig().config;
}

export function getProfile(): RalphProfile {
  return getConfig().profile ?? "prod";
}

export function isSandboxProfile(): boolean {
  return getProfile() === "sandbox";
}

export function getSandboxProfileConfig(): SandboxProfileConfig | null {
  const cfg = getConfig();
  return cfg.profile === "sandbox" ? (cfg.sandbox ?? null) : null;
}

export function getSandboxProvisioningConfig(): SandboxProvisioningConfig | null {
  const sandbox = getSandboxProfileConfig();
  return sandbox?.provisioning ?? null;
}

export function getRepoPath(repoName: string): string {
  const cfg = getConfig();
  
  // Check if we have an explicit config for this repo
  const explicit = cfg.repos.find(r => r.name === repoName);
  if (explicit) return explicit.path;
  
  // Otherwise, derive from convention: ~/Developer/{repo-short-name}
  const shortName = repoName.includes("/") ? repoName.split("/")[1] : repoName;
  return join(cfg.devDir, shortName);
}

export function getRepoBotBranch(repoName: string): string {
  const cfg = getConfig();
  const explicit = cfg.repos.find(r => r.name === repoName);
  return explicit?.botBranch ?? "bot/integration";
}

export function getRepoRequiredChecksOverride(repoName: string): string[] | null {
  const cfg = getConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  return toStringArrayOrNull(explicit?.requiredChecks);
}

export function getRepoSetupCommands(repoName: string): string[] | null {
  const cfg = getConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  if (!explicit || (explicit as any).setup === undefined) return null;

  const parsed = toStringArrayOrNull((explicit as any).setup);
  if (parsed === null) {
    console.warn(
      `[ralph] Invalid config setup for repo ${repoName}: ${JSON.stringify((explicit as any).setup)}; ignoring.`
    );
    return null;
  }
  return parsed;
}

export function getGlobalMaxWorkers(): number {
  return getConfig().maxWorkers;
}

export function getDashboardEventsRetentionDays(): number {
  const cfg = getConfig();
  const raw = cfg.dashboard?.eventsRetentionDays;
  const parsed = toPositiveIntOrNull(raw);
  return parsed ?? DEFAULT_DASHBOARD_EVENTS_RETENTION_DAYS;
}

export function getSandboxRetentionPolicy(): { keepLast: number; keepFailedDays: number } {
  const sandbox = getSandboxProfileConfig();
  const keepLast = toNonNegativeIntOrNull(sandbox?.retention?.keepLast) ?? DEFAULT_SANDBOX_KEEP_LAST;
  const keepFailedDays = toNonNegativeIntOrNull(sandbox?.retention?.keepFailedDays) ?? DEFAULT_SANDBOX_KEEP_FAILED_DAYS;
  return { keepLast, keepFailedDays };
}

export function getRepoConcurrencySlots(repoName: string): number {
  const cfg = getConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  const slots = toPositiveIntOrNull(explicit?.concurrencySlots);
  if (slots) return slots;
  const maxWorkers = toPositiveIntOrNull(explicit?.maxWorkers);
  return maxWorkers ?? DEFAULT_REPO_CONCURRENCY_SLOTS;
}

export function getRepoMaxWorkers(repoName: string): number {
  return getRepoConcurrencySlots(repoName);
}

export function getRepoRollupBatchSize(repoName: string, fallback?: number): number {
  const cfg = getConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  const rollupBatch = toPositiveIntOrNull(explicit?.rollupBatchSize);
  return rollupBatch ?? fallback ?? cfg.batchSize;
}

export function isAutoUpdateBehindEnabled(repoName: string): boolean {
  const cfg = getConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  return explicit?.autoUpdateBehindPrs ?? false;
}

export function getAutoUpdateBehindLabelGate(repoName: string): string | null {
  const cfg = getConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  const label = explicit?.autoUpdateBehindLabel;
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

export function getAutoUpdateBehindMinMinutes(repoName: string): number {
  const cfg = getConfig();
  const explicit = cfg.repos.find((r) => r.name === repoName);
  const parsed = toPositiveIntOrNull(explicit?.autoUpdateBehindMinMinutes);
  return parsed ?? DEFAULT_AUTO_UPDATE_BEHIND_MIN_MINUTES;
}

export function normalizeRepoName(repo: string): string {
  const cfg = getConfig();
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
  const cfg = getConfig();
  return cfg.opencode?.enabled ?? false;
}

export function listOpencodeProfileNames(): string[] {
  const cfg = getConfig();
  const profiles = cfg.opencode?.profiles;
  if (!profiles || typeof profiles !== "object") return [];
  return Object.keys(profiles).sort();
}

export function getOpencodeDefaultProfileName(): string | null {
  const cfg = getConfig();
  const raw = cfg.opencode?.defaultProfile;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

export function resolveOpencodeProfile(name?: string | null): ResolvedOpencodeProfile | null {
  const cfg = getConfig();
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
