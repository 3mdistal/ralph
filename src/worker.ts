import { $ } from "bun";
import { appendFile, mkdir, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { dirname, isAbsolute, join } from "path";

type GhCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type GhProcess = {
  cwd: (path: string) => GhProcess;
  quiet: () => Promise<GhCommandResult>;
};

type GhRunner = (strings: TemplateStringsArray, ...values: unknown[]) => GhProcess;

const DEFAULT_GH_RUNNER: GhRunner = $ as unknown as GhRunner;

const gh: GhRunner = DEFAULT_GH_RUNNER;

import { type AgentTask, updateTaskStatus } from "./queue";
import {
  getOpencodeDefaultProfileName,
  getRepoBotBranch,
  getRepoMaxWorkers,
  getRepoRequiredChecks,
  isOpencodeProfilesEnabled,
  loadConfig,
  resolveOpencodeProfile,
} from "./config";
import { ensureGhTokenEnv, getAllowedOwners, isRepoAllowed } from "./github-app-auth";
import { continueCommand, continueSession, getRalphXdgCacheHome, runCommand, type SessionResult } from "./session";
import { getThrottleDecision } from "./throttle";

import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "./opencode-auto-profile";
import { readControlStateSnapshot } from "./drain";
import { extractPrUrl, extractPrUrlFromSession, hasProductGap, parseRoutingDecision, type RoutingDecision } from "./routing";
import { computeLiveAnomalyCountFromJsonl } from "./anomaly";
import {
  isExplicitBlockerReason,
  isImplementationTaskFromIssue,
  shouldConsultDevex,
  shouldEscalateAfterRouting,
  type IssueMetadata,
} from "./escalation";
import { notifyEscalation, notifyError, notifyTaskComplete, type EscalationContext } from "./notify";
import { drainQueuedNudges } from "./nudge";
import { computeMissingBaselineLabels } from "./github-labels";
import { getRalphRunLogPath, getRalphSessionsDir, getRalphWorktreesDir } from "./paths";
import { recordIssueSnapshot } from "./state";
import {
  parseGitWorktreeListPorcelain,
  pickWorktreeForIssue,
  stripHeadsRef,
  type GitWorktreeEntry,
} from "./git-worktree";

type SessionAdapter = {
  runCommand: typeof runCommand;
  continueSession: typeof continueSession;
  continueCommand: typeof continueCommand;
  getRalphXdgCacheHome: typeof getRalphXdgCacheHome;
};

const DEFAULT_SESSION_ADAPTER: SessionAdapter = {
  runCommand,
  continueSession,
  continueCommand,
  getRalphXdgCacheHome,
};

type QueueAdapter = {
  updateTaskStatus: typeof updateTaskStatus;
};

type NotifyAdapter = {
  notifyEscalation: typeof notifyEscalation;
  notifyError: typeof notifyError;
  notifyTaskComplete: typeof notifyTaskComplete;
};

type ThrottleAdapter = {
  getThrottleDecision: typeof getThrottleDecision;
};

const DEFAULT_QUEUE_ADAPTER: QueueAdapter = {
  updateTaskStatus,
};

const DEFAULT_NOTIFY_ADAPTER: NotifyAdapter = {
  notifyEscalation,
  notifyError,
  notifyTaskComplete,
};

const DEFAULT_THROTTLE_ADAPTER: ThrottleAdapter = {
  getThrottleDecision,
};

// Ralph introspection logs location
const RALPH_SESSIONS_DIR = getRalphSessionsDir();

// Git worktrees for per-task repo isolation
const RALPH_WORKTREES_DIR = getRalphWorktreesDir();

// Anomaly detection thresholds
const ANOMALY_BURST_THRESHOLD = 50; // Abort if this many anomalies detected
const MAX_ANOMALY_ABORTS = 3; // Max times to abort and retry before escalating

interface IntrospectionSummary {
  sessionId: string;
  endTime: number;
  toolResultAsTextCount: number;
  totalToolCalls: number;
  stepCount: number;
  hasAnomalies: boolean;
  recentTools: string[];
}

interface LiveAnomalyCount {
  total: number;
  recentBurst: boolean;
}

async function readIntrospectionSummary(sessionId: string): Promise<IntrospectionSummary | null> {
  const summaryPath = join(RALPH_SESSIONS_DIR, sessionId, "summary.json");
  if (!existsSync(summaryPath)) return null;
  
  try {
    const content = await readFile(summaryPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Read live anomaly count from the session's events.jsonl.
 * Returns total count and whether there's been a recent burst.
 */
async function readLiveAnomalyCount(sessionId: string): Promise<LiveAnomalyCount> {
  const eventsPath = join(RALPH_SESSIONS_DIR, sessionId, "events.jsonl");
  if (!existsSync(eventsPath)) return { total: 0, recentBurst: false };

  try {
    const content = await readFile(eventsPath, "utf8");
    return computeLiveAnomalyCountFromJsonl(content, Date.now());
  } catch {
    return { total: 0, recentBurst: false };
  }
}

async function cleanupIntrospectionLogs(sessionId: string): Promise<void> {
  const sessionDir = join(RALPH_SESSIONS_DIR, sessionId);
  if (existsSync(sessionDir)) {
    try {
      await rm(sessionDir, { recursive: true });
    } catch (e) {
      console.warn(`[ralph:worker] Failed to cleanup introspection logs: ${e}`);
    }
  }
}

export interface AgentRun {
  taskName: string;
  repo: string;
  outcome: "success" | "throttled" | "escalated" | "failed";
  pr?: string;
  sessionId?: string;
  escalationReason?: string;
  surveyResults?: string;
}

function safeNoteName(name: string): string {
  return name
    .replace(/[\\/]/g, " - ")
    .replace(/[:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeForNote(text: string, maxChars = 900): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trimEnd() + "…";
}

function resolveVaultPath(p: string): string {
  const vault = loadConfig().bwrbVault;
  return isAbsolute(p) ? p : join(vault, p);
}

type RequiredCheckState = "SUCCESS" | "PENDING" | "FAILURE" | "UNKNOWN";

type PrCheck = {
  name: string;
  state: RequiredCheckState;
  rawState: string;
};

type RequiredChecksSummary = {
  status: "success" | "pending" | "failure";
  required: Array<{ name: string; state: RequiredCheckState; rawState: string }>;
  available: string[];
};

type RestrictionEntry = { login?: string | null; slug?: string | null };

type RestrictionList = {
  users?: RestrictionEntry[] | null;
  teams?: RestrictionEntry[] | null;
  apps?: RestrictionEntry[] | null;
};

type BranchProtection = {
  required_status_checks?: {
    strict?: boolean | null;
    contexts?: string[] | null;
    checks?: Array<{ context?: string | null }> | null;
  } | null;
  enforce_admins?: { enabled?: boolean | null } | boolean | null;
  required_pull_request_reviews?: {
    dismissal_restrictions?: RestrictionList | null;
    dismiss_stale_reviews?: boolean | null;
    require_code_owner_reviews?: boolean | null;
    required_approving_review_count?: number | null;
    require_last_push_approval?: boolean | null;
    bypass_pull_request_allowances?: RestrictionList | null;
  } | null;
  restrictions?: RestrictionList | null;
  required_linear_history?: { enabled?: boolean | null } | boolean | null;
  allow_force_pushes?: { enabled?: boolean | null } | boolean | null;
  allow_deletions?: { enabled?: boolean | null } | boolean | null;
  block_creations?: { enabled?: boolean | null } | boolean | null;
  required_conversation_resolution?: { enabled?: boolean | null } | boolean | null;
  required_signatures?: { enabled?: boolean | null } | boolean | null;
  lock_branch?: { enabled?: boolean | null } | boolean | null;
  allow_fork_syncing?: { enabled?: boolean | null } | boolean | null;
};

type CheckRunsResponse = {
  check_runs?: Array<{ name?: string | null }> | null;
};

function splitRepoFullName(full: string): { owner: string; name: string } {
  const [owner, name] = full.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo name (expected owner/name): ${full}`);
  }
  return { owner, name };
}

function toSortedUniqueStrings(values: Array<string | null | undefined>): string[] {
  const normalized = values.map((value) => (value ?? "").trim()).filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function normalizeEnabledFlag(value: { enabled?: boolean | null } | boolean | null | undefined): boolean {
  if (typeof value === "boolean") return value;
  return Boolean(value?.enabled);
}

function normalizeRestrictions(source: RestrictionList | null | undefined): { users: string[]; teams: string[]; apps: string[] } | null {
  const users = toSortedUniqueStrings(source?.users?.map((entry) => entry?.login ?? "") ?? []);
  const teams = toSortedUniqueStrings(source?.teams?.map((entry) => entry?.slug ?? "") ?? []);
  const apps = toSortedUniqueStrings(source?.apps?.map((entry) => entry?.slug ?? "") ?? []);
  if (users.length === 0 && teams.length === 0 && apps.length === 0) return null;
  return { users, teams, apps };
}

function hasBypassAllowances(source: RestrictionList | null | undefined): boolean {
  const normalized = normalizeRestrictions(source);
  if (!normalized) return false;
  return normalized.users.length > 0 || normalized.teams.length > 0 || normalized.apps.length > 0;
}

function getProtectionContexts(protection: BranchProtection | null): string[] {
  const contexts = protection?.required_status_checks?.contexts ?? [];
  const checks = protection?.required_status_checks?.checks ?? [];
  const checkContexts = checks.map((check) => check?.context ?? "");
  return toSortedUniqueStrings([...contexts, ...checkContexts]);
}

function extractPullRequestNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:$|\b|\/)/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

const CI_ONLY_PATH_PREFIXES = [".github/workflows/", ".github/actions/"] as const;
const CI_ONLY_PATH_EXACT = [".github/action.yml", ".github/action.yaml"] as const;
const CI_LABEL_KEYWORDS = ["ci", "build", "infra"] as const;

function isCiOnlyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized) return false;
  if (CI_ONLY_PATH_EXACT.includes(normalized as (typeof CI_ONLY_PATH_EXACT)[number])) return true;
  return CI_ONLY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isCiOnlyChangeSet(files: string[]): boolean {
  const normalized = files.map((file) => file.trim()).filter(Boolean);
  if (normalized.length === 0) return false;
  return normalized.every((file) => isCiOnlyPath(file));
}

function isCiRelatedIssue(labels: string[]): boolean {
  return labels.some((label) => {
    const normalized = label.toLowerCase();
    return CI_LABEL_KEYWORDS.some((keyword) => {
      const re = new RegExp(`(^|[-_/])${keyword}($|[-_/])`);
      return re.test(normalized);
    });
  });
}

export function __isCiOnlyChangeSetForTests(files: string[]): boolean {
  return isCiOnlyChangeSet(files);
}

export function __isCiRelatedIssueForTests(labels: string[]): boolean {
  return isCiRelatedIssue(labels);
}

function normalizeRequiredCheckState(raw: string | null | undefined): RequiredCheckState {
  const val = String(raw ?? "").toUpperCase();
  if (!val) return "UNKNOWN";
  if (val === "SUCCESS") return "SUCCESS";

  // Common non-success terminal states.
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"].includes(val)) {
    return "FAILURE";
  }

  // Treat everything else (including IN_PROGRESS, QUEUED, PENDING) as pending.
  return "PENDING";
}

function summarizeRequiredChecks(allChecks: PrCheck[], requiredChecks: string[]): RequiredChecksSummary {
  const available = Array.from(new Set(allChecks.map((c) => c.name))).sort();

  const required = requiredChecks.map((name) => {
    const match = allChecks.find((c) => c.name === name);
    if (!match) return { name, state: "UNKNOWN" as const, rawState: "missing" };
    return { name, state: match.state, rawState: match.rawState };
  });

  if (requiredChecks.length === 0) {
    return { status: "success", required: [], available };
  }

  const hasFailure = required.some((c) => c.state === "FAILURE");
  if (hasFailure) return { status: "failure", required, available };

  const allSuccess = required.length > 0 && required.every((c) => c.state === "SUCCESS");
  if (allSuccess) return { status: "success", required, available };

  return { status: "pending", required, available };
}

export function __summarizeRequiredChecksForTests(
  allChecks: PrCheck[],
  requiredChecks: string[]
): RequiredChecksSummary {
  return summarizeRequiredChecks(allChecks, requiredChecks);
}

function formatRequiredChecksForHumans(summary: RequiredChecksSummary): string {
  const lines: string[] = [];
  lines.push(`Required checks: ${summary.required.map((c) => c.name).join(", ") || "(none)"}`);
  for (const chk of summary.required) {
    lines.push(`- ${chk.name}: ${chk.rawState}`);
  }

  if (summary.available.length > 0) {
    lines.push("", "Available check contexts:", ...summary.available.map((c) => `- ${c}`));
  }

  return lines.join("\n");
}

export class RepoWorker {
  private session: SessionAdapter;
  private queue: QueueAdapter;
  private notify: NotifyAdapter;
  private throttle: ThrottleAdapter;

  constructor(
    public readonly repo: string,
    public readonly repoPath: string,
    opts?: {
      session?: SessionAdapter;
      queue?: QueueAdapter;
      notify?: NotifyAdapter;
      throttle?: ThrottleAdapter;
    }
  ) {
    this.session = opts?.session ?? DEFAULT_SESSION_ADAPTER;
    this.queue = opts?.queue ?? DEFAULT_QUEUE_ADAPTER;
    this.notify = opts?.notify ?? DEFAULT_NOTIFY_ADAPTER;
    this.throttle = opts?.throttle ?? DEFAULT_THROTTLE_ADAPTER;
  }

  private ensureLabelsPromise: Promise<void> | null = null;
  private ensureBranchProtectionPromise: Promise<void> | null = null;

  private async blockDisallowedRepo(task: AgentTask, started: Date, phase: "start" | "resume"): Promise<AgentRun> {
    const completed = new Date();
    const completedAt = completed.toISOString().split("T")[0];
    const owners = getAllowedOwners();

    const reason = `Repo owner is not in allowlist (repo=${task.repo}, allowedOwners=${owners.join(", ") || "none"})`;

    console.warn(`[ralph:worker:${this.repo}] RALPH_BLOCKED_ALLOWLIST ${reason}`);

    await this.createAgentRun(task, {
      outcome: "failed",
      started,
      completed,
      sessionId: task["session-id"]?.trim() || undefined,
      bodyPrefix: [
        "Blocked: repo owner not in allowlist",
        "",
        `Phase: ${phase}`,
        `Repo: ${task.repo}`,
        `Allowed owners: ${owners.join(", ")}`,
      ].join("\n"),
    });

    await this.queue.updateTaskStatus(task, "blocked", {
      "completed-at": completedAt,
      "session-id": "",
      "watchdog-retries": "",
      ...(task["worktree-path"] ? { "worktree-path": "" } : {}),
    });

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "failed",
      escalationReason: reason,
    };
  }

  private async recordRunLogPath(task: AgentTask, issueNumber: string, stepTitle: string): Promise<string | undefined> {
    const runLogPath = getRalphRunLogPath({ repo: this.repo, issueNumber, stepTitle, ts: Date.now() });
    const updated = await this.queue.updateTaskStatus(task, "in-progress", { "run-log-path": runLogPath });
    if (!updated) {
      console.warn(`[ralph:worker:${this.repo}] Failed to persist run-log-path (continuing): ${runLogPath}`);
    }
    return runLogPath;
  }

  private async ensureBaselineLabelsOnce(): Promise<void> {


    if (this.ensureLabelsPromise) return this.ensureLabelsPromise;

    this.ensureLabelsPromise = (async () => {
      try {
        const result = await gh`gh label list --repo ${this.repo} --json name`.quiet();
        const raw = JSON.parse(result.stdout.toString());
        const existing = Array.isArray(raw) ? raw.map((l: any) => String(l?.name ?? "")) : [];

        const missing = computeMissingBaselineLabels(existing);
        if (missing.length === 0) return;

        const created: string[] = [];
        for (const label of missing) {
          try {
            await gh`gh label create ${label.name} --repo ${this.repo} --color ${label.color} --description ${label.description}`.quiet();
            created.push(label.name);
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            if (/already exists/i.test(msg)) continue;
            throw e;
          }
        }

        if (created.length > 0) {
          console.log(`[ralph:worker:${this.repo}] Created GitHub label(s): ${created.join(", ")}`);
        }
      } catch (e: any) {
        console.warn(
          `[ralph:worker:${this.repo}] Failed to ensure baseline GitHub labels (continuing): ${e?.message ?? String(e)}`
        );
      }
    })();

    return this.ensureLabelsPromise;
  }

  private getGitHubToken(): string {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("Missing GH_TOKEN/GITHUB_TOKEN; cannot update branch protection.");
    }
    return token;
  }

  private async githubApiRequest<T>(
    path: string,
    opts: { method?: string; body?: unknown; allowNotFound?: boolean } = {}
  ): Promise<T | null> {
    const token = this.getGitHubToken();
    const url = `https://api.github.com${path.startsWith("/") ? "" : "/"}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `token ${token}`,
      "User-Agent": "ralph-loop",
    };

    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
    };

    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, init);
    if (opts.allowNotFound && res.status === 404) return null;

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `GitHub API ${init.method} ${path} failed (HTTP ${res.status}). ${text.slice(0, 400)}`.trim()
      );
    }

    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async fetchCheckRunNames(branch: string): Promise<string[]> {
    const { owner, name } = splitRepoFullName(this.repo);
    const payload = await this.githubApiRequest<CheckRunsResponse>(
      `/repos/${owner}/${name}/commits/${branch}/check-runs?per_page=100`
    );
    return toSortedUniqueStrings(payload?.check_runs?.map((run) => run?.name ?? "") ?? []);
  }

  private async fetchBranchProtection(branch: string): Promise<BranchProtection | null> {
    const { owner, name } = splitRepoFullName(this.repo);
    return this.githubApiRequest<BranchProtection>(
      `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`,
      { allowNotFound: true }
    );
  }

  private async ensureBranchProtectionForBranch(branch: string, requiredChecks: string[]): Promise<void> {
    if (requiredChecks.length === 0) return;

    const availableChecks = await this.fetchCheckRunNames(branch);
    const missingChecks = requiredChecks.filter((check) => !availableChecks.includes(check));
    if (missingChecks.length > 0) {
      throw new Error(
        `Required checks missing for ${this.repo}@${branch}: ${missingChecks.join(", ")}. ` +
          `Available checks: ${availableChecks.join(", ") || "(none)"}`
      );
    }

    const existing = await this.fetchBranchProtection(branch);
    const contexts = toSortedUniqueStrings([...getProtectionContexts(existing), ...requiredChecks]);
    const strict = existing?.required_status_checks?.strict === true;
    const reviews = existing?.required_pull_request_reviews;

    const desiredReviews = {
      dismissal_restrictions: normalizeRestrictions(reviews?.dismissal_restrictions),
      dismiss_stale_reviews: reviews?.dismiss_stale_reviews ?? false,
      require_code_owner_reviews: reviews?.require_code_owner_reviews ?? false,
      required_approving_review_count: 0,
      require_last_push_approval: reviews?.require_last_push_approval ?? false,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    };

    const desiredPayload = {
      required_status_checks: { strict, contexts },
      enforce_admins: true,
      required_pull_request_reviews: desiredReviews,
      restrictions: normalizeRestrictions(existing?.restrictions),
      required_linear_history: normalizeEnabledFlag(existing?.required_linear_history),
      allow_force_pushes: normalizeEnabledFlag(existing?.allow_force_pushes),
      allow_deletions: normalizeEnabledFlag(existing?.allow_deletions),
      block_creations: normalizeEnabledFlag(existing?.block_creations),
      required_conversation_resolution: normalizeEnabledFlag(existing?.required_conversation_resolution),
      required_signatures: normalizeEnabledFlag(existing?.required_signatures),
      lock_branch: normalizeEnabledFlag(existing?.lock_branch),
      allow_fork_syncing: normalizeEnabledFlag(existing?.allow_fork_syncing),
    };

    const existingContexts = getProtectionContexts(existing);
    const needsStatusUpdate = !existing || !areStringArraysEqual(existingContexts, contexts);
    const existingApprovals = reviews?.required_approving_review_count ?? null;
    const needsReviewUpdate =
      !reviews || existingApprovals !== 0 || hasBypassAllowances(reviews?.bypass_pull_request_allowances);
    const needsAdminUpdate = !normalizeEnabledFlag(existing?.enforce_admins);

    if (!existing || needsStatusUpdate || needsReviewUpdate || needsAdminUpdate) {
      const { owner, name } = splitRepoFullName(this.repo);
      await this.githubApiRequest(
        `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`,
        { method: "PUT", body: desiredPayload }
      );
      console.log(
        `[ralph:worker:${this.repo}] Ensured branch protection for ${branch} (required checks: ${requiredChecks.join(", ")})`
      );
    }
  }

  private async ensureBranchProtectionOnce(): Promise<void> {
    if (this.ensureBranchProtectionPromise) return this.ensureBranchProtectionPromise;

    this.ensureBranchProtectionPromise = (async () => {
      const botBranch = getRepoBotBranch(this.repo);
      const branches = Array.from(new Set([botBranch, "main"]));
      const requiredChecks = getRepoRequiredChecks(this.repo);
      for (const branch of branches) {
        await this.ensureBranchProtectionForBranch(branch, requiredChecks);
      }
    })();

    return this.ensureBranchProtectionPromise;
  }

  private async resolveWorktreeRef(): Promise<string> {
    const botBranch = getRepoBotBranch(this.repo);
    try {
      await $`git rev-parse --verify ${botBranch}`.cwd(this.repoPath).quiet();
      return botBranch;
    } catch {
      return "HEAD";
    }
  }

  private async ensureGitWorktree(worktreePath: string): Promise<void> {
    const worktreeGitMarker = join(worktreePath, ".git");

    const hasHealthyWorktree = () => existsSync(worktreePath) && existsSync(worktreeGitMarker);

    const cleanupBrokenWorktree = async (): Promise<void> => {
      try {
        await $`git worktree remove --force ${worktreePath}`.cwd(this.repoPath).quiet();
      } catch {
        // ignore
      }

      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    // If git knows about the worktree but the path is broken, clean it up.
    try {
      const list = await $`git worktree list --porcelain`.cwd(this.repoPath).quiet();
      const out = list.stdout.toString();
      if (out.includes(`worktree ${worktreePath}\n`)) {
        if (hasHealthyWorktree()) return;
        console.warn(`[ralph:worker:${this.repo}] Worktree registered but unhealthy; recreating: ${worktreePath}`);
        await cleanupBrokenWorktree();
      }
    } catch {
      // ignore and attempt create
    }

    // If the directory exists but is not a valid git worktree, remove it.
    if (existsSync(worktreePath) && !hasHealthyWorktree()) {
      console.warn(`[ralph:worker:${this.repo}] Worktree path exists but is not a worktree; recreating: ${worktreePath}`);
      await cleanupBrokenWorktree();
    }

    await mkdir(dirname(worktreePath), { recursive: true });

    const ref = await this.resolveWorktreeRef();
    const create = async () => {
      await $`git worktree add --detach ${worktreePath} ${ref}`.cwd(this.repoPath).quiet();
      if (!hasHealthyWorktree()) {
        throw new Error(`Worktree created but missing .git marker: ${worktreePath}`);
      }
    };

    try {
      await create();
    } catch (e: any) {
      // Retry once after forcing cleanup. This handles half-created directories or stale git metadata.
      await cleanupBrokenWorktree();
      await create();
    }
  }

  private async cleanupGitWorktree(worktreePath: string): Promise<void> {
    try {
      await $`git worktree remove --force ${worktreePath}`.cwd(this.repoPath).quiet();
    } catch (e: any) {
      console.warn(`[ralph:worker:${this.repo}] Failed to remove worktree ${worktreePath}: ${e?.message ?? String(e)}`);
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  private async resolveTaskRepoPath(
    task: AgentTask,
    issueNumber: string,
    mode: "start" | "resume"
  ): Promise<{ repoPath: string; worktreePath?: string }> {
    const recorded = task["worktree-path"]?.trim();
    if (recorded && existsSync(recorded)) {
      return { repoPath: recorded, worktreePath: recorded };
    }

    if (recorded && !existsSync(recorded)) {
      console.warn(
        `[ralph:worker:${this.repo}] Recorded worktree-path does not exist; falling back to main repo checkout: ${recorded}`
      );
    }

    // Only create worktrees for new runs (not resume), and only when per-repo concurrency > 1.
    if (mode === "resume") {
      return { repoPath: this.repoPath };
    }

    const maxWorkers = getRepoMaxWorkers(this.repo);
    if (maxWorkers <= 1) {
      return { repoPath: this.repoPath };
    }

    const taskKey = safeNoteName(task._path || task._name || task.name);
    const repoKey = safeNoteName(this.repo);
    const worktreePath = join(RALPH_WORKTREES_DIR, repoKey, issueNumber, taskKey);

    await this.ensureGitWorktree(worktreePath);
    await this.queue.updateTaskStatus(task, "starting", { "worktree-path": worktreePath });

    return { repoPath: worktreePath, worktreePath };
  }

  /**
   * Fetch metadata for a GitHub issue.
   */
  private async getIssueMetadata(issue: string): Promise<IssueMetadata> {
    // issue format: "owner/repo#123"
    const match = issue.match(/^([^#]+)#(\d+)$/);
    if (!match) return { labels: [], title: "" };

    const [, repo, number] = match;
    try {
      const result = await gh`gh issue view ${number} --repo ${repo} --json state,stateReason,closedAt,url,labels,title`.quiet();
      const data = JSON.parse(result.stdout.toString());
      const metadata: IssueMetadata = {
        labels: data.labels?.map((l: any) => l.name) ?? [],
        title: data.title ?? "",
        state: typeof data.state === "string" ? data.state : undefined,
        stateReason: typeof data.stateReason === "string" ? data.stateReason : undefined,
        closedAt: typeof data.closedAt === "string" ? data.closedAt : undefined,
        url: typeof data.url === "string" ? data.url : undefined,
      };

      recordIssueSnapshot({
        repo,
        issue,
        title: metadata.title,
        state: metadata.state,
        url: metadata.url,
      });

      return metadata;
    } catch {
      return { labels: [], title: "" };
    }
  }

  private buildPrCreationNudge(botBranch: string, issueNumber: string, issueRef: string): string {
    const fixes = issueNumber ? `Fixes #${issueNumber}` : `Fixes ${issueRef}`;

    return [
      `No PR URL found. Create a PR targeting '${botBranch}' and paste the PR URL.`,
      "",
      "Commands (run in the task worktree):",
      "```bash",
      "git status",
      "git push -u origin HEAD",
      `gh pr create --base ${botBranch} --fill --body \"${fixes}\"`,
      "```",
      "",
      "If a PR already exists:",
      "```bash",
      "gh pr list --head $(git branch --show-current) --json url --limit 1",
      "```",
    ].join("\n");
  }

  private async getGitWorktrees(): Promise<GitWorktreeEntry[]> {
    try {
      const result = await $`git worktree list --porcelain`.cwd(this.repoPath).quiet();
      return parseGitWorktreeListPorcelain(result.stdout.toString());
    } catch {
      return [];
    }
  }

  private async tryEnsurePrFromWorktree(params: {
    task: AgentTask;
    issueNumber: string;
    issueTitle: string;
    botBranch: string;
  }): Promise<{ prUrl: string | null; diagnostics: string }> {
    const { task, issueNumber, issueTitle, botBranch } = params;

    await ensureGhTokenEnv();

    const diagnostics: string[] = [

      "Ralph PR recovery:",
      `- Repo: ${this.repo}`,
      `- Issue: ${task.issue}`,
      `- Base: ${botBranch}`,
    ];

    if (!issueNumber) {
      diagnostics.push("- No issue number detected; skipping auto PR recovery");
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    const entries = await this.getGitWorktrees();
    const candidate = pickWorktreeForIssue(entries, issueNumber, {
      deprioritizeBranches: ["main", botBranch],
    });

    if (!candidate) {
      diagnostics.push(`- No worktree matched issue ${issueNumber}`);
      diagnostics.push("- Manual: run `git worktree list` in the repo root to locate the task worktree");
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    const branch = stripHeadsRef(candidate.branch);
    diagnostics.push(`- Worktree: ${candidate.worktreePath}`);
    diagnostics.push(`- Branch: ${branch ?? "(unknown)"}`);

    if (!branch || candidate.detached) {
      diagnostics.push("- Cannot auto-create PR: detached HEAD or unknown branch");
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    try {
      const list = await gh`gh pr list --repo ${this.repo} --head ${branch} --json url --limit 1`.quiet();
      const data = JSON.parse(list.stdout.toString());
      const existingUrl = data?.[0]?.url as string | undefined;
      if (existingUrl) {
        diagnostics.push(`- Found existing PR: ${existingUrl}`);
        return { prUrl: existingUrl, diagnostics: diagnostics.join("\n") };
      }
    } catch (e: any) {
      diagnostics.push(`- gh pr list failed: ${e?.message ?? String(e)}`);
    }

    try {
      const status = await $`git status --porcelain`.cwd(candidate.worktreePath).quiet();
      if (status.stdout.toString().trim()) {
        diagnostics.push("- Worktree has uncommitted changes; skipping auto push/PR create");
        diagnostics.push(`- Manual: cd ${candidate.worktreePath} && git status`);
        return { prUrl: null, diagnostics: diagnostics.join("\n") };
      }
    } catch (e: any) {
      diagnostics.push(`- git status failed: ${e?.message ?? String(e)}`);
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    try {
      await $`git push -u origin HEAD`.cwd(candidate.worktreePath).quiet();
      diagnostics.push("- Pushed branch to origin");
    } catch (e: any) {
      diagnostics.push(`- git push failed: ${e?.message ?? String(e)}`);
      diagnostics.push(`- Manual: cd ${candidate.worktreePath} && git push -u origin ${branch}`);
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    const title = issueTitle?.trim() ? issueTitle.trim() : `Fixes #${issueNumber}`;
    const body = [
      `Fixes #${issueNumber}`,
      "",
      "## Summary",
      "- (Auto-created by Ralph: agent completed without a PR URL)",
      "",
      "## Testing",
      "- (Please fill in)",
      "",
    ].join("\n");

    try {
      const created = await gh`gh pr create --repo ${this.repo} --base ${botBranch} --head ${branch} --title ${title} --body ${body}`
        .cwd(candidate.worktreePath)
        .quiet();

      const prUrl = extractPrUrl(created.stdout.toString()) ?? null;
      diagnostics.push(prUrl ? `- Created PR: ${prUrl}` : "- gh pr create succeeded but no URL detected");

      if (prUrl) return { prUrl, diagnostics: diagnostics.join("\n") };
    } catch (e: any) {
      diagnostics.push(`- gh pr create failed: ${e?.message ?? String(e)}`);
    }

    try {
      const list = await gh`gh pr list --repo ${this.repo} --head ${branch} --json url --limit 1`.quiet();
      const data = JSON.parse(list.stdout.toString());
      const url = data?.[0]?.url as string | undefined;
      if (url) {
        diagnostics.push(`- Found PR after create attempt: ${url}`);
        return { prUrl: url, diagnostics: diagnostics.join("\n") };
      }
    } catch (e: any) {
      diagnostics.push(`- Final gh pr list failed: ${e?.message ?? String(e)}`);
    }

    diagnostics.push("- No PR URL recovered");
    return { prUrl: null, diagnostics: diagnostics.join("\n") };
  }

  private async getPullRequestChecks(prUrl: string): Promise<{ headSha: string; checks: PrCheck[] }> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) {
      throw new Error(`Could not parse pull request number from URL: ${prUrl}`);
    }

    const { owner, name } = splitRepoFullName(this.repo);

    const query = [
      "query($owner:String!,$name:String!,$number:Int!){",
      "repository(owner:$owner,name:$name){",
      "pullRequest(number:$number){",
      "headRefOid",
      "statusCheckRollup{",
      "contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}",
      "}",
      "}",
      "}",
      "}",
    ].join(" ");

    const result = await gh`gh api graphql -f query=${query} -f owner=${owner} -f name=${name} -F number=${prNumber}`.quiet();
    const parsed = JSON.parse(result.stdout.toString());

    const pr = parsed?.data?.repository?.pullRequest;
    const headSha = pr?.headRefOid as string | undefined;
    if (!headSha) {
      throw new Error(`Failed to read pull request head SHA for ${prUrl}`);
    }

    const nodes = pr?.statusCheckRollup?.contexts?.nodes;
    const checksRaw = Array.isArray(nodes) ? nodes : [];

    const checks: PrCheck[] = [];

    for (const node of checksRaw) {
      const type = String(node?.__typename ?? "");

      if (type === "CheckRun") {
        const name = String(node?.name ?? "").trim();
        if (!name) continue;

        const status = String(node?.status ?? "");
        const conclusion = String(node?.conclusion ?? "");

        // If it's not completed yet, treat status as the state.
        const rawState = status && status !== "COMPLETED" ? status : conclusion || status || "UNKNOWN";
        checks.push({ name, rawState, state: normalizeRequiredCheckState(rawState) });
        continue;
      }

      if (type === "StatusContext") {
        const name = String(node?.context ?? "").trim();
        if (!name) continue;

        const rawState = String(node?.state ?? "UNKNOWN");
        checks.push({ name, rawState, state: normalizeRequiredCheckState(rawState) });
        continue;
      }
    }

    return { headSha, checks };
  }

  private async getPullRequestFiles(prUrl: string): Promise<string[]> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) {
      throw new Error(`Could not parse pull request number from URL: ${prUrl}`);
    }

    const { owner, name } = splitRepoFullName(this.repo);
    const files: string[] = [];
    let page = 1;

    while (true) {
      const payload = await this.githubApiRequest<Array<{ filename?: string | null }>>(
        `/repos/${owner}/${name}/pulls/${prNumber}/files?per_page=100&page=${page}`
      );

      if (!payload || payload.length === 0) break;

      for (const entry of payload) {
        const filename = String(entry?.filename ?? "").trim();
        if (filename) files.push(filename);
      }

      if (payload.length < 100) break;
      page += 1;
    }

    return files;
  }

  private async waitForRequiredChecks(
    prUrl: string,
    requiredChecks: string[],
    opts: { timeoutMs: number; pollIntervalMs: number }
  ): Promise<{ headSha: string; summary: RequiredChecksSummary; timedOut: boolean }> {
    const startedAt = Date.now();
    let last: { headSha: string; summary: RequiredChecksSummary } | null = null;

    while (Date.now() - startedAt < opts.timeoutMs) {
      const { headSha, checks } = await this.getPullRequestChecks(prUrl);
      const summary = summarizeRequiredChecks(checks, requiredChecks);
      last = { headSha, summary };

      if (summary.status === "success" || summary.status === "failure") {
        return { headSha, summary, timedOut: false };
      }

      await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
    }

    if (last) {
      return { headSha: last.headSha, summary: last.summary, timedOut: true };
    }

    // Should be unreachable, but keep types happy.
    const fallback = await this.getPullRequestChecks(prUrl);
    return {
      headSha: fallback.headSha,
      summary: summarizeRequiredChecks(fallback.checks, requiredChecks),
      timedOut: true,
    };
  }

  private async mergePullRequest(prUrl: string, headSha: string, cwd: string): Promise<void> {
    // Never pass --admin or -d (delete branch). The orchestrator should not bypass checks or clean up git branches.
    await gh`gh pr merge ${prUrl} --repo ${this.repo} --merge --match-head-commit ${headSha}`.cwd(cwd).quiet();
  }

  private async updatePullRequestBranch(prUrl: string, cwd: string): Promise<void> {
    await gh`gh pr update-branch ${prUrl} --repo ${this.repo}`.cwd(cwd).quiet();
  }

  private isOutOfDateMergeError(error: any): boolean {
    const message = String(error?.stderr ?? error?.message ?? "");
    if (!message) return false;
    return /not up to date with the base branch/i.test(message);
  }

  private formatGhError(error: any): string {
    const message = String(error?.message ?? "").trim();
    const stderr = String(error?.stderr ?? "").trim();
    return [message, stderr].filter(Boolean).join("\n");
  }

  private async mergePrWithRequiredChecks(params: {
    task: AgentTask;
    repoPath: string;
    cacheKey: string;
    botBranch: string;
    prUrl: string;
    sessionId: string;
    issueMeta: IssueMetadata;
    watchdogStagePrefix: string;
    notifyTitle: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
  }): Promise<{ ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }> {
    const REQUIRED_CHECKS = getRepoRequiredChecks(this.repo);
    const MAX_CI_FIX_ATTEMPTS = 3;

    let prUrl = params.prUrl;
    let sessionId = params.sessionId;
    let lastSummary: RequiredChecksSummary | null = null;
    let didUpdateBranch = false;

    const prFiles = await this.getPullRequestFiles(prUrl);
    const ciOnly = isCiOnlyChangeSet(prFiles);
    const isCiIssue = isCiRelatedIssue(params.issueMeta.labels ?? []);

    if (ciOnly && !isCiIssue) {
      const completed = new Date();
      const completedAt = completed.toISOString().split("T")[0];
      const reason = `Guardrail: PR only changes CI/workflows for non-CI issue ${params.task.issue}`;

      await this.createAgentRun(params.task, {
        outcome: "failed",
        started: completed,
        completed,
        sessionId,
        bodyPrefix: [
          "Blocked: CI-only PR for non-CI issue",
          "",
          `Issue: ${params.task.issue}`,
          `PR: ${prUrl}`,
          `Files: ${prFiles.join(", ") || "(none)"}`,
        ].join("\n"),
      });

      await this.queue.updateTaskStatus(params.task, "blocked", {
        "completed-at": completedAt,
        "session-id": "",
        "watchdog-retries": "",
        ...(params.task["worktree-path"] ? { "worktree-path": "" } : {}),
      });

      await this.notify.notifyError(params.notifyTitle, reason, params.task.name);

      return {
        ok: false,
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          pr: prUrl ?? undefined,
          sessionId,
          escalationReason: reason,
        },
      };
    }

    for (let attempt = 1; attempt <= MAX_CI_FIX_ATTEMPTS; attempt++) {
      const checkResult = await this.waitForRequiredChecks(prUrl, REQUIRED_CHECKS, {
        timeoutMs: 45 * 60_000,
        pollIntervalMs: 30_000,
      });

      lastSummary = checkResult.summary;

      if (checkResult.summary.status === "success") {
        console.log(`[ralph:worker:${this.repo}] Required checks passed; merging ${prUrl}`);
        try {
          await this.mergePullRequest(prUrl, checkResult.headSha, params.repoPath);
          return { ok: true, prUrl, sessionId };
        } catch (error: any) {
          if (!didUpdateBranch && this.isOutOfDateMergeError(error)) {
            console.log(`[ralph:worker:${this.repo}] PR out of date with base; updating branch ${prUrl}`);
            didUpdateBranch = true;
            try {
              await this.updatePullRequestBranch(prUrl, params.repoPath);
              continue;
            } catch (updateError: any) {
              const reason = `Failed while updating PR branch before merge: ${this.formatGhError(updateError)}`;
              console.warn(`[ralph:worker:${this.repo}] ${reason}`);
              await this.queue.updateTaskStatus(params.task, "blocked");
              await this.notify.notifyError(params.notifyTitle, reason, params.task.name);

              return {
                ok: false,
                run: {
                  taskName: params.task.name,
                  repo: this.repo,
                  outcome: "failed",
                  sessionId,
                  escalationReason: reason,
                },
              };
            }
          }
          throw error;
        }
      }

      if (attempt >= MAX_CI_FIX_ATTEMPTS) break;

      const fixMessage = [
        `CI is required before merging to '${params.botBranch}'.`,
        `PR: ${prUrl}`,
        "",
        checkResult.timedOut
          ? "Timed out waiting for required checks to complete."
          : "One or more required checks failed.",
        "",
        formatRequiredChecksForHumans(checkResult.summary),
        "",
        "Do NOT merge yet.",
        "Fix the CI failure (or rerun CI), push updates to the PR branch, and reply when CI is green.",
        "",
        "Commands:",
        "```bash",
        `gh pr checks ${prUrl} --repo ${this.repo}`,
        "```",
      ].join("\n");

      const issueNumber = params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey;
      const runLogPath = await this.recordRunLogPath(params.task, issueNumber, `${params.watchdogStagePrefix}-fix-ci`);

      const fixResult = await this.session.continueSession(params.repoPath, sessionId, fixMessage, {
        repo: this.repo,
        cacheKey: params.cacheKey,
        runLogPath,
        introspection: {
          repo: this.repo,
          issue: params.task.issue,
          taskName: params.task.name,
          step: 5,
          stepTitle: "fix CI",
        },
        ...this.buildWatchdogOptions(params.task, `${params.watchdogStagePrefix}-ci-fix`),
        ...(params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {}),
      });

      sessionId = fixResult.sessionId || sessionId;

      if (!fixResult.success) {
        if (fixResult.watchdogTimeout) {
          const run = await this.handleWatchdogTimeout(
            params.task,
            params.cacheKey,
            `${params.watchdogStagePrefix}-ci-fix`,
            fixResult,
            params.opencodeXdg
          );
          return { ok: false, run };
        }

        const reason = `Failed while fixing CI before merge: ${fixResult.output}`;
        console.warn(`[ralph:worker:${this.repo}] ${reason}`);
        await this.queue.updateTaskStatus(params.task, "blocked");
        await this.notify.notifyError(params.notifyTitle, reason, params.task.name);

        return {
          ok: false,
          run: {
            taskName: params.task.name,
            repo: this.repo,
            outcome: "failed",
            sessionId,
            escalationReason: reason,
          },
        };
      }

      if (fixResult.sessionId) {
        await this.queue.updateTaskStatus(params.task, "in-progress", { "session-id": fixResult.sessionId });
      }

      const updatedPrUrl = extractPrUrl(fixResult.output);
      if (updatedPrUrl) prUrl = updatedPrUrl;
    }

    const summaryText = lastSummary ? formatRequiredChecksForHumans(lastSummary) : "";
    const reason = `Required checks not passing; refusing to merge ${prUrl}`;
    console.warn(`[ralph:worker:${this.repo}] ${reason}`);

    await this.queue.updateTaskStatus(params.task, "blocked");
    await this.notify.notifyError(params.notifyTitle, [reason, summaryText].filter(Boolean).join("\n\n"), params.task.name);

    return {
      ok: false,
      run: {
        taskName: params.task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId,
        escalationReason: reason,
      },
    };
  }

  private async skipClosedIssue(task: AgentTask, issueMeta: IssueMetadata, started: Date): Promise<AgentRun> {
    const completed = new Date();
    const completedAt = completed.toISOString().split("T")[0];

    const issueUrl = issueMeta.url ?? task.issue;
    const closedAt = issueMeta.closedAt ?? "";
    const stateReason = issueMeta.stateReason ?? "";

    console.log(
      `[ralph:worker:${this.repo}] RALPH_SKIP_CLOSED issue=${issueUrl} closedAt=${closedAt || "unknown"} task=${task.name}`
    );

    await this.createAgentRun(task, {
      outcome: "success",
      started,
      completed,
      sessionId: task["session-id"]?.trim() || undefined,
      bodyPrefix: [
        "Skipped: issue already closed upstream",
        "",
        `Issue: ${issueUrl}`,
        `closedAt: ${closedAt || "unknown"}`,
        stateReason ? `stateReason: ${stateReason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });

    await this.queue.updateTaskStatus(task, "done", {
      "completed-at": completedAt,
      "session-id": "",
      "watchdog-retries": "",
      ...(task["worktree-path"] ? { "worktree-path": "" } : {}),
    });

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "success",
    };
  }

  /**
   * Determine if we should escalate based on routing decision.
   */
  private shouldEscalate(

    routing: RoutingDecision | null,
    hasGap: boolean,
    isImplementationTask: boolean
  ): boolean {
    return shouldEscalateAfterRouting({ routing, hasGap });
  }

  private getWatchdogRetryCount(task: AgentTask): number {
    const raw = task["watchdog-retries"];
    const parsed = Number.parseInt(String(raw ?? "0"), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private buildWatchdogOptions(task: AgentTask, stage: string) {
    const cfg = loadConfig().watchdog;
    const context = `[${this.repo}] ${task.name} (${task.issue}) stage=${stage}`;

    return {
      watchdog: {
        enabled: cfg?.enabled ?? true,
        thresholdsMs: cfg?.thresholdsMs,
        softLogIntervalMs: cfg?.softLogIntervalMs,
        recentEventLimit: cfg?.recentEventLimit,
        context,
      },
    };
  }

  private getPinnedOpencodeProfileName(task: AgentTask): string | null {
    const raw = task["opencode-profile"];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed ? trimmed : null;
  }

  private async resolveOpencodeXdgForTask(
    task: AgentTask,
    phase: "start" | "resume"
  ): Promise<{
    profileName: string | null;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    error?: string;
  }> {
    if (!isOpencodeProfilesEnabled()) return { profileName: null };

    const pinned = this.getPinnedOpencodeProfileName(task);

    if (pinned) {
      const resolved = resolveOpencodeProfile(pinned);
      if (!resolved) {
        return {
          profileName: pinned,
          error:
            `Task is pinned to an unknown OpenCode profile ${JSON.stringify(pinned)} (task ${task.issue}). ` +
            `Configure it under [opencode.profiles.${pinned}] in ~/.ralph/config.toml (paths must be absolute; no '~' expansion).`,
        };
      }

      return {
        profileName: resolved.name,
        opencodeXdg: {
          dataHome: resolved.xdgDataHome,
          configHome: resolved.xdgConfigHome,
          stateHome: resolved.xdgStateHome,
          cacheHome: resolved.xdgCacheHome,
        },
      };
    }

    const control = readControlStateSnapshot({ log: (message) => console.warn(message) });
    const requested = control.opencodeProfile?.trim() ?? "";

    let resolved = null as ReturnType<typeof resolveOpencodeProfile>;

    if (requested === "auto") {
      const chosen = await resolveAutoOpencodeProfileName(Date.now(), {
        getThrottleDecision: this.throttle.getThrottleDecision,
      });
      if (phase === "start") {
        console.log(`[ralph:worker:${this.repo}] Auto-selected OpenCode profile=${JSON.stringify(chosen ?? "")}`);
      }
      resolved = chosen ? resolveOpencodeProfile(chosen) : resolveOpencodeProfile(null);
    } else if (phase === "start") {
      const selection = await resolveOpencodeProfileForNewWork(Date.now(), requested || null, {
        getThrottleDecision: this.throttle.getThrottleDecision,
      });
      const chosen = selection.profileName;

      if (selection.source === "failover") {
        console.log(
          `[ralph:worker:${this.repo}] Hard throttle on profile=${selection.requestedProfile ?? "default"}; ` +
            `failing over to profile=${chosen ?? "ambient"}`
        );
      }

      resolved = chosen ? resolveOpencodeProfile(chosen) : null;
    } else {
      resolved = requested ? resolveOpencodeProfile(requested) : null;
    }

    if (requested && requested !== "auto" && !resolved) {
      console.warn(
        `[ralph:worker:${this.repo}] Control opencode_profile=${JSON.stringify(requested)} does not match a configured profile; ` +
          `falling back to defaultProfile=${JSON.stringify(getOpencodeDefaultProfileName() ?? "")}`
      );
      resolved = resolveOpencodeProfile(null);
    }

    if (!resolved) {
      if (phase === "start" && requested) {
        console.warn(`[ralph:worker:${this.repo}] Unable to resolve OpenCode profile for new task; running with ambient XDG dirs`);
      }
      return { profileName: null };
    }

    return {
      profileName: resolved.name,
      opencodeXdg: {
        dataHome: resolved.xdgDataHome,
        configHome: resolved.xdgConfigHome,
        stateHome: resolved.xdgStateHome,
        cacheHome: resolved.xdgCacheHome,
      },
    };
  }

  private async pauseIfHardThrottled(task: AgentTask, stage: string, sessionId?: string): Promise<AgentRun | null> {
    const pinned = this.getPinnedOpencodeProfileName(task);
    const sid = sessionId?.trim() || task["session-id"]?.trim() || "";
    const hasSession = !!sid;

    let decision: Awaited<ReturnType<typeof getThrottleDecision>>;

    if (pinned) {
      decision = await this.throttle.getThrottleDecision(Date.now(), { opencodeProfile: pinned });
    } else {
      const controlProfile = readControlStateSnapshot({ log: (message) => console.warn(message) }).opencodeProfile?.trim() ?? "";

      if (controlProfile === "auto") {
        const chosen = await resolveAutoOpencodeProfileName(Date.now(), {
          getThrottleDecision: this.throttle.getThrottleDecision,
        });

        decision = await this.throttle.getThrottleDecision(Date.now(), {
          opencodeProfile: chosen ?? getOpencodeDefaultProfileName(),
        });
      } else if (!hasSession) {
        // Safe to fail over between profiles before starting a new session.
        decision = (
          await resolveOpencodeProfileForNewWork(Date.now(), controlProfile || null, {
            getThrottleDecision: this.throttle.getThrottleDecision,
          })
        ).decision;
      } else {
        // Do not fail over while a session is in flight/resuming.
        decision = await this.throttle.getThrottleDecision(Date.now(), { opencodeProfile: controlProfile || getOpencodeDefaultProfileName() });
      }
    }

    if (decision.state !== "hard") return null;

    const throttledAt = new Date().toISOString();
    const resumeAt = decision.resumeAtTs ? new Date(decision.resumeAtTs).toISOString() : "";

    const extraFields: Record<string, string> = {
      "throttled-at": throttledAt,
      "resume-at": resumeAt,
      "usage-snapshot": JSON.stringify(decision.snapshot),
    };

    if (sid) extraFields["session-id"] = sid;

    await this.queue.updateTaskStatus(task, "throttled", extraFields);

    console.log(
      `[ralph:worker:${this.repo}] Hard throttle active; pausing at checkpoint stage=${stage} resumeAt=${resumeAt || "unknown"}`
    );

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "throttled",
      sessionId: sid || undefined,
    };
  }

  private async drainNudges(
    task: AgentTask,
    repoPath: string,
    sessionId: string,
    cacheKey: string,
    stage: string,
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string }
  ): Promise<void> {
    const sid = sessionId?.trim();
    if (!sid) return;

    try {
      const issueNumber = task.issue.match(/#(\d+)$/)?.[1] ?? cacheKey;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      const result = await drainQueuedNudges(sid, async (message) => {
        const paused = await this.pauseIfHardThrottled(task, `nudge-${stage}`, sid);
        if (paused) {
          return { success: false, error: "hard throttled" };
        }

        const runLogPath = await this.recordRunLogPath(task, issueNumber, `nudge-${stage}`);

        const res = await this.session.continueSession(repoPath, sid, message, {
          repo: this.repo,
          cacheKey,
          runLogPath,
          ...this.buildWatchdogOptions(task, `nudge-${stage}`),
          ...opencodeSessionOptions,
        });
        return { success: res.success, error: res.success ? undefined : res.output };
      });

      if (result.attempted > 0) {
        const suffix = result.stoppedOnError ? " (stopped on error)" : "";
        console.log(
          `[ralph:worker:${this.repo}] Delivered ${result.delivered}/${result.attempted} queued nudge(s)${suffix}`
        );
      }
    } catch (e: any) {
      console.warn(`[ralph:worker:${this.repo}] Failed to drain nudges: ${e?.message ?? String(e)}`);
    }
  }

  private async handleWatchdogTimeout(
    task: AgentTask,
    cacheKey: string,
    stage: string,
    result: SessionResult,
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string }
  ): Promise<AgentRun> {
    const timeout = result.watchdogTimeout;
    const retryCount = this.getWatchdogRetryCount(task);
    const nextRetryCount = retryCount + 1;

    const reason = timeout
      ? `Tool call timed out: ${timeout.toolName} ${timeout.callId} after ${Math.round(timeout.elapsedMs / 1000)}s (${stage})`
      : `Tool call timed out (${stage})`;

    // Cleanup per-task OpenCode cache on watchdog timeouts (best-effort)
    try {
      await rm(this.session.getRalphXdgCacheHome(this.repo, cacheKey, opencodeXdg?.cacheHome), { recursive: true, force: true });
    } catch {
      // ignore
    }

    if (retryCount === 0) {
      console.warn(`[ralph:worker:${this.repo}] Watchdog hard timeout; re-queuing once for recovery: ${reason}`);
      await this.queue.updateTaskStatus(task, "queued", {
        "session-id": "",
        "watchdog-retries": String(nextRetryCount),
      });

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: result.sessionId || undefined,
        escalationReason: reason,
      };
    }

    console.log(`[ralph:worker:${this.repo}] Watchdog hard timeout repeated; escalating: ${reason}`);

    const escalationFields: Record<string, string> = {
      "watchdog-retries": String(nextRetryCount),
    };
    if (result.sessionId) escalationFields["session-id"] = result.sessionId;

    await this.queue.updateTaskStatus(task, "escalated", escalationFields);

    await this.notify.notifyEscalation({
      taskName: task.name,
      taskFileName: task._name,
      taskPath: task._path,
      issue: task.issue,
      repo: this.repo,
      scope: task.scope,
      priority: task.priority,
      sessionId: result.sessionId || task["session-id"]?.trim() || undefined,
      reason,
      escalationType: "other",
      planOutput: result.output,
    });

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId: result.sessionId || undefined,
      escalationReason: reason,
    };
  }

  async resumeTask(task: AgentTask, opts?: { resumeMessage?: string }): Promise<AgentRun> {
    const startTime = new Date();
    console.log(`[ralph:worker:${this.repo}] Resuming task: ${task.name}`);

    if (!isRepoAllowed(task.repo)) {
      return await this.blockDisallowedRepo(task, startTime, "resume");
    }

    await ensureGhTokenEnv();

    const issueMeta = await this.getIssueMetadata(task.issue);
    if (issueMeta.state === "CLOSED") {
      return await this.skipClosedIssue(task, issueMeta, startTime);
    }

    await this.ensureBaselineLabelsOnce();
    await this.ensureBranchProtectionOnce();

    const issueMatch = task.issue.match(/#(\d+)$/);
    const issueNumber = issueMatch?.[1] ?? "";
    const cacheKey = issueNumber || task._name;

    const { repoPath: taskRepoPath, worktreePath } = await this.resolveTaskRepoPath(task, issueNumber || cacheKey, "resume");

      const existingSessionId = task["session-id"]?.trim();
      if (!existingSessionId) {
        const reason = "In-progress task has no session-id; cannot resume";
        console.warn(`[ralph:worker:${this.repo}] ${reason}: ${task.name}`);
        await this.queue.updateTaskStatus(task, "starting", { "session-id": "" });
        return { taskName: task.name, repo: this.repo, outcome: "failed", escalationReason: reason };
      }


    try {
      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "resume");
      if (resolvedOpencode.error) throw new Error(resolvedOpencode.error);

      const opencodeProfileName = resolvedOpencode.profileName;
      const opencodeXdg = resolvedOpencode.opencodeXdg;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      if (!task["opencode-profile"]?.trim() && opencodeProfileName) {
        await this.queue.updateTaskStatus(task, "in-progress", { "opencode-profile": opencodeProfileName });
      }

      const botBranch = getRepoBotBranch(this.repo);
      const issueMeta = await this.getIssueMetadata(task.issue);

      const defaultResumeMessage =
        "Ralph restarted while this task was in progress. " +
        "Resume from where you left off. " +
        "If you already created a PR, paste the PR URL. " +
        `Otherwise continue implementing and create a PR targeting the '${botBranch}' branch.`;

      const resumeMessage = opts?.resumeMessage?.trim() || defaultResumeMessage;

      const pausedBefore = await this.pauseIfHardThrottled(task, "resume", existingSessionId);
      if (pausedBefore) return pausedBefore;

      const resumeRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "resume");

      let buildResult = await this.session.continueSession(taskRepoPath, existingSessionId, resumeMessage, {
        repo: this.repo,
        cacheKey,
        runLogPath: resumeRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 4,
          stepTitle: "resume",
        },
        ...this.buildWatchdogOptions(task, "resume"),
        ...opencodeSessionOptions,
      });

      const pausedAfter = await this.pauseIfHardThrottled(task, "resume (post)", buildResult.sessionId || existingSessionId);
      if (pausedAfter) return pausedAfter;

      if (!buildResult.success) {
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume", buildResult, opencodeXdg);
        }

        const reason = `Failed to resume OpenCode session ${existingSessionId}: ${buildResult.output}`;
        console.warn(`[ralph:worker:${this.repo}] Resume failed; falling back to fresh run: ${reason}`);

        // Fall back to a fresh run by clearing session-id and re-queueing.
        await this.queue.updateTaskStatus(task, "queued", { "session-id": "" });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: existingSessionId,
          escalationReason: reason,
        };
      }

      if (buildResult.sessionId) {
        await this.queue.updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume", opencodeXdg);

      // Extract PR URL (with retry loop if agent stopped without creating PR)
      const MAX_CONTINUE_RETRIES = 5;
      let prUrl = extractPrUrlFromSession(buildResult);
      let prRecoveryDiagnostics = "";

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = recovered.diagnostics;
        prUrl = recovered.prUrl ?? prUrl;
      }

      let continueAttempts = 0;
      let anomalyAborts = 0;
      let lastAnomalyCount = 0;

      while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
        await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume", opencodeXdg);

        const anomalyStatus = await readLiveAnomalyCount(buildResult.sessionId);
        const newAnomalies = anomalyStatus.total - lastAnomalyCount;
        lastAnomalyCount = anomalyStatus.total;

        if (anomalyStatus.total >= ANOMALY_BURST_THRESHOLD || anomalyStatus.recentBurst) {
          anomalyAborts++;
          console.warn(
            `[ralph:worker:${this.repo}] Anomaly burst detected (${anomalyStatus.total} total, ${newAnomalies} new). ` +
              `Abort #${anomalyAborts}/${MAX_ANOMALY_ABORTS}`
          );

          if (anomalyAborts >= MAX_ANOMALY_ABORTS) {
            const reason = `Agent stuck in tool-result-as-text loop (${anomalyStatus.total} anomalies detected, aborted ${anomalyAborts} times)`;
            console.log(`[ralph:worker:${this.repo}] Escalating due to repeated anomaly loops`);

            await this.queue.updateTaskStatus(task, "escalated");
            await this.notify.notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
              reason,
              escalationType: "other",
              planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
            });

            return {
              taskName: task.name,
              repo: this.repo,
              outcome: "escalated",
              sessionId: buildResult.sessionId,
              escalationReason: reason,
            };
          }

          console.log(`[ralph:worker:${this.repo}] Sending loop-break nudge...`);

          const pausedLoopBreak = await this.pauseIfHardThrottled(task, "resume loop-break", buildResult.sessionId || existingSessionId);
          if (pausedLoopBreak) return pausedLoopBreak;

          const loopBreakRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "resume loop-break");

          buildResult = await this.session.continueSession(
            taskRepoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            {
              repo: this.repo,
              cacheKey,
              runLogPath: loopBreakRunLogPath,
              introspection: {
                repo: this.repo,
                issue: task.issue,
                taskName: task.name,
                step: 4,
                stepTitle: "resume loop-break",
              },
              ...this.buildWatchdogOptions(task, "resume-loop-break"),
              ...opencodeSessionOptions,
            }
          );

          const pausedLoopBreakAfter = await this.pauseIfHardThrottled(
            task,
            "resume loop-break (post)",
            buildResult.sessionId || existingSessionId
          );
          if (pausedLoopBreakAfter) return pausedLoopBreakAfter;

          if (!buildResult.success) {
            if (buildResult.watchdogTimeout) {
              return await this.handleWatchdogTimeout(task, cacheKey, "resume-loop-break", buildResult, opencodeXdg);
            }
            console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
            break;
          }

          lastAnomalyCount = anomalyStatus.total;
          prUrl = extractPrUrlFromSession(buildResult);

          continue;
        }

        continueAttempts++;
        console.log(
          `[ralph:worker:${this.repo}] No PR URL found; requesting PR creation (attempt ${continueAttempts}/${MAX_CONTINUE_RETRIES})`
        );

        const pausedContinue = await this.pauseIfHardThrottled(task, "resume continue", buildResult.sessionId || existingSessionId);
        if (pausedContinue) return pausedContinue;

        const nudge = this.buildPrCreationNudge(botBranch, issueNumber, task.issue);
        const resumeContinueRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "continue");

        buildResult = await this.session.continueSession(taskRepoPath, buildResult.sessionId, nudge, {
          repo: this.repo,
          cacheKey,
          runLogPath: resumeContinueRunLogPath,
          timeoutMs: 10 * 60_000,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "continue",
          },
          ...this.buildWatchdogOptions(task, "resume-continue"),
          ...opencodeSessionOptions,
        });

        const pausedContinueAfter = await this.pauseIfHardThrottled(
          task,
          "resume continue (post)",
          buildResult.sessionId || existingSessionId
        );
        if (pausedContinueAfter) return pausedContinueAfter;

        if (!buildResult.success) {
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "resume-continue", buildResult, opencodeXdg);
          }

          // If the session ended without printing a URL, try to recover PR from git state.
          const recovered = await this.tryEnsurePrFromWorktree({
            task,
            issueNumber,
            issueTitle: issueMeta.title || task.name,
            botBranch,
          });
          prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
          prUrl = recovered.prUrl ?? prUrl;

          if (!prUrl) {
            console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
            break;
          }
        } else {
          prUrl = extractPrUrlFromSession(buildResult);
        }
      }

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
        prUrl = recovered.prUrl ?? prUrl;
      }

      if (!prUrl) {
        const reason = `Agent completed but did not create a PR after ${continueAttempts} continue attempts`;
        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        await this.queue.updateTaskStatus(task, "escalated");
        await this.notify.notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
          reason,
          escalationType: "other",
          planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
        });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: buildResult.sessionId,
          escalationReason: reason,
        };
      }

      const pausedMerge = await this.pauseIfHardThrottled(task, "resume merge", buildResult.sessionId || existingSessionId);
      if (pausedMerge) return pausedMerge;

      const mergeGate = await this.mergePrWithRequiredChecks({
        task,
        repoPath: taskRepoPath,
        cacheKey,
        botBranch,
        prUrl,
        sessionId: buildResult.sessionId,
        issueMeta,
        watchdogStagePrefix: "merge",
        notifyTitle: `Merging ${task.name}`,
        opencodeXdg,
      });


      if (!mergeGate.ok) return mergeGate.run;

      const pausedMergeAfter = await this.pauseIfHardThrottled(
        task,
        "resume merge (post)",
        mergeGate.sessionId || buildResult.sessionId || existingSessionId
      );
      if (pausedMergeAfter) return pausedMergeAfter;

      prUrl = mergeGate.prUrl;
      buildResult.sessionId = mergeGate.sessionId;

      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const pausedSurvey = await this.pauseIfHardThrottled(task, "resume survey", buildResult.sessionId || existingSessionId);
      if (pausedSurvey) return pausedSurvey;

      const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
      const resumeSurveyRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "survey");

        const surveyResult = await this.session.continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
          repo: this.repo,
          cacheKey,
          runLogPath: resumeSurveyRunLogPath,
          ...this.buildWatchdogOptions(task, "resume-survey"),
          ...opencodeSessionOptions,
        });


      const pausedSurveyAfter = await this.pauseIfHardThrottled(task, "resume survey (post)", surveyResult.sessionId || buildResult.sessionId || existingSessionId);
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume-survey", surveyResult, opencodeXdg);
        }
        console.warn(`[ralph:worker:${this.repo}] Survey may have failed: ${surveyResult.output}`);
      }

      const endTime = new Date();
      await this.createAgentRun(task, {
        sessionId: buildResult.sessionId,
        pr: prUrl,
        outcome: "success",
        started: startTime,
        completed: endTime,
        surveyResults: surveyResult.output,
      });

      await this.queue.updateTaskStatus(task, "done", {
        "completed-at": endTime.toISOString().split("T")[0],
        "session-id": "",
        "watchdog-retries": "",
        ...(worktreePath ? { "worktree-path": "" } : {}),
      });

      // Cleanup per-task OpenCode cache on success
      await rm(this.session.getRalphXdgCacheHome(this.repo, cacheKey, opencodeXdg?.cacheHome), { recursive: true, force: true });

      if (worktreePath) {
        await this.cleanupGitWorktree(worktreePath);
      }

      console.log(`[ralph:worker:${this.repo}] Task resumed to completion: ${task.name}`);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "success",
        pr: prUrl ?? undefined,
        sessionId: buildResult.sessionId,
      };
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Resume failed:`, error);

      await this.queue.updateTaskStatus(task, "blocked");
      await this.notify.notifyError(`Resuming ${task.name}`, error?.message ?? String(error), task.name);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
    }
  }

  async processTask(task: AgentTask): Promise<AgentRun> {
    const startTime = new Date();
    console.log(`[ralph:worker:${this.repo}] Starting task: ${task.name}`);


    try {
      // 1. Extract issue number (e.g., "3mdistal/bwrb#245" -> "245")
      const issueMatch = task.issue.match(/#(\d+)$/);
      if (!issueMatch) throw new Error(`Invalid issue format: ${task.issue}`);
      const issueNumber = issueMatch[1];
      const cacheKey = issueNumber;

      if (!isRepoAllowed(task.repo)) {
        return await this.blockDisallowedRepo(task, startTime, "start");
      }

      await ensureGhTokenEnv();

      // 2. Preflight: skip work if the upstream issue is already CLOSED
      const issueMeta = await this.getIssueMetadata(task.issue);
      if (issueMeta.state === "CLOSED") {
        return await this.skipClosedIssue(task, issueMeta, startTime);
      }

      const pausedPreStart = await this.pauseIfHardThrottled(task, "pre-start");
      if (pausedPreStart) return pausedPreStart;

      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "start");
      if (resolvedOpencode.error) throw new Error(resolvedOpencode.error);

      const opencodeProfileName = resolvedOpencode.profileName;
      const opencodeXdg = resolvedOpencode.opencodeXdg;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      // 3. Mark task starting (restart-safe pre-session state)
      const markedStarting = await this.queue.updateTaskStatus(task, "starting", {
        "assigned-at": startTime.toISOString().split("T")[0],
        ...(!task["opencode-profile"]?.trim() && opencodeProfileName ? { "opencode-profile": opencodeProfileName } : {}),
      });
      if (!markedStarting) {
        throw new Error("Failed to mark task starting (bwrb edit failed)");
      }

      await this.ensureBaselineLabelsOnce();
      await this.ensureBranchProtectionOnce();

      const { repoPath: taskRepoPath, worktreePath } = await this.resolveTaskRepoPath(task, issueNumber, "start");

      // 4. Determine whether this is an implementation-ish task
      const isImplementationTask = isImplementationTaskFromIssue(issueMeta);

      // 4. Run configured command: next-task
      console.log(`[ralph:worker:${this.repo}] Running /next-task ${issueNumber}`);

      // Transient OpenCode cache races can cause ENOENT during module imports (e.g. zod locales).
      // With per-run cache isolation this should be rare, but we still retry once for robustness.
      const isTransientCacheENOENT = (output: string) =>
        /ENOENT\s+reading\s+"[^"]*\/opencode\/node_modules\//.test(output) ||
        /ENOENT\s+reading\s+"[^"]*zod\/v4\/locales\//.test(output);

      const pausedNextTask = await this.pauseIfHardThrottled(task, "next-task");
      if (pausedNextTask) return pausedNextTask;

      const nextTaskRunLogPath = await this.recordRunLogPath(task, issueNumber, "next-task");

      let planResult = await this.session.runCommand(taskRepoPath, "next-task", [issueNumber], {
        repo: this.repo,
        cacheKey,
        runLogPath: nextTaskRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 1,
          stepTitle: "next-task",
        },
        ...this.buildWatchdogOptions(task, "next-task"),
        ...opencodeSessionOptions,
      });

      const pausedAfterNextTask = await this.pauseIfHardThrottled(task, "next-task (post)", planResult.sessionId);
      if (pausedAfterNextTask) return pausedAfterNextTask;

      if (!planResult.success && planResult.watchdogTimeout) {
        return await this.handleWatchdogTimeout(task, cacheKey, "next-task", planResult, opencodeXdg);
      }

      if (!planResult.success && isTransientCacheENOENT(planResult.output)) {
        console.warn(`[ralph:worker:${this.repo}] /next-task hit transient cache ENOENT; retrying once...`);
        await new Promise((r) => setTimeout(r, 750));
        const nextTaskRetryRunLogPath = await this.recordRunLogPath(task, issueNumber, "next-task-retry");

        planResult = await this.session.runCommand(taskRepoPath, "next-task", [issueNumber], {
          repo: this.repo,
          cacheKey,
          runLogPath: nextTaskRetryRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 1,
            stepTitle: "next-task (retry)",
          },
          ...this.buildWatchdogOptions(task, "next-task-retry"),
          ...opencodeSessionOptions,
        });
      }

      const pausedAfterNextTaskRetry = await this.pauseIfHardThrottled(task, "next-task (post retry)", planResult.sessionId);
      if (pausedAfterNextTaskRetry) return pausedAfterNextTaskRetry;

      if (!planResult.success) {
        if (planResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "next-task", planResult, opencodeXdg);
        }
        throw new Error(`/next-task failed: ${planResult.output}`);
      }

      // Persist OpenCode session ID for crash recovery
      if (planResult.sessionId) {
        await this.queue.updateTaskStatus(task, "in-progress", { "session-id": planResult.sessionId });
      }

      // 5. Parse routing decision
      let routing = parseRoutingDecision(planResult.output);
      let hasGap = hasProductGap(planResult.output);

      // 6. Consult devex once before escalating implementation tasks
      let devexContext: EscalationContext["devex"] | undefined;
      if (shouldConsultDevex({ routing, hasGap, isImplementationTask })) {
        const baseSessionId = planResult.sessionId;
        console.log(
          `[ralph:worker:${this.repo}] Consulting @devex before escalation (task: ${task.name}, session: ${baseSessionId})`
        );

        const devexPrompt = [
          "You are @devex.",
          "Resolve low-level implementation ambiguity (style, error message patterns, validation scope that does not change public behavior).",
          "IMPORTANT: This runs in a non-interactive daemon. Do NOT ask questions; make reasonable default choices and proceed.",
          "Return a short, actionable summary.",
        ].join("\n");

        const pausedDevexConsult = await this.pauseIfHardThrottled(task, "consult devex", baseSessionId);
        if (pausedDevexConsult) return pausedDevexConsult;

        const devexRunLogPath = await this.recordRunLogPath(task, issueNumber, "consult devex");

        const devexResult = await this.session.continueSession(taskRepoPath, baseSessionId, devexPrompt, {
          agent: "devex",
          repo: this.repo,
          cacheKey,
          runLogPath: devexRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 2,
            stepTitle: "consult devex",
          },
          ...opencodeSessionOptions,
        });

        const pausedAfterDevexConsult = await this.pauseIfHardThrottled(
          task,
          "consult devex (post)",
          devexResult.sessionId || baseSessionId
        );
        if (pausedAfterDevexConsult) return pausedAfterDevexConsult;

        if (!devexResult.success) {
          console.warn(`[ralph:worker:${this.repo}] Devex consult failed: ${devexResult.output}`);
          devexContext = {
            consulted: true,
            sessionId: devexResult.sessionId || baseSessionId,
            summary: `Devex consult failed: ${summarizeForNote(devexResult.output, 400)}`,
          };
        } else {
          const devexSummary = summarizeForNote(devexResult.output);
          devexContext = {
            consulted: true,
            sessionId: devexResult.sessionId || baseSessionId,
            summary: devexSummary,
          };

          console.log(
            `[ralph:worker:${this.repo}] Devex consulted (task: ${task.name}, session: ${devexContext.sessionId})`
          );

          const reroutePrompt = [
            "Incorporate the devex guidance below into your plan.",
            "Then output ONLY the routing decision JSON code block.",
            "Do not ask questions.",
            "If an open question touches a user-facing contract surface (e.g. CLI flags/args, exit codes, stdout/stderr formats, config schema, machine-readable outputs), set decision=escalate (policy: docs/escalation-policy.md).",
            "",
            "Devex guidance:",
            devexSummary || devexResult.output,
          ].join("\n");

          const pausedReroute = await this.pauseIfHardThrottled(task, "reroute after devex", baseSessionId);
          if (pausedReroute) return pausedReroute;

          const rerouteRunLogPath = await this.recordRunLogPath(task, issueNumber, "reroute after devex");

          const rerouteResult = await this.session.continueSession(taskRepoPath, baseSessionId, reroutePrompt, {
            repo: this.repo,
            cacheKey,
            runLogPath: rerouteRunLogPath,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 3,
              stepTitle: "reroute after devex",
            },
            ...opencodeSessionOptions,
          });

          const pausedAfterReroute = await this.pauseIfHardThrottled(
            task,
            "reroute after devex (post)",
            rerouteResult.sessionId || baseSessionId
          );
          if (pausedAfterReroute) return pausedAfterReroute;

          if (!rerouteResult.success) {
            console.warn(`[ralph:worker:${this.repo}] Reroute after devex consult failed: ${rerouteResult.output}`);
          } else {
            if (rerouteResult.sessionId) {
              await this.queue.updateTaskStatus(task, "in-progress", { "session-id": rerouteResult.sessionId });
            }

            const updatedRouting = parseRoutingDecision(rerouteResult.output);
            if (updatedRouting) routing = updatedRouting;

            // Allow product-gap detection to trigger if the reroute output explicitly flags it.
            hasGap = hasGap || hasProductGap(rerouteResult.output);
          }
        }

      }

      // 7. Decide whether to escalate
      const shouldEscalate = this.shouldEscalate(routing, hasGap, isImplementationTask);
      
      if (shouldEscalate) {
        const reason =
          routing?.escalation_reason ||
          (hasGap
            ? "Product documentation gap identified"
            : routing?.decision === "escalate" && routing?.confidence === "high"
              ? "High-confidence escalation requested"
              : "Escalation requested");

        // Determine escalation type
        let escalationType: EscalationContext["escalationType"] = "other";
        if (hasGap) {
          escalationType = "product-gap";
        } else if (isExplicitBlockerReason(routing?.escalation_reason)) {
          escalationType = "blocked";
        } else if (routing?.escalation_reason?.toLowerCase().includes("ambiguous")) {
          escalationType = "ambiguous-requirements";
        }


        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        await this.queue.updateTaskStatus(task, "escalated");
        await this.notify.notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          sessionId: planResult.sessionId,
          reason,
          escalationType,
          planOutput: planResult.output,
          routing: routing
            ? {
                decision: routing.decision,
                confidence: routing.confidence,
                escalation_reason: routing.escalation_reason ?? undefined,
                plan_summary: routing.plan_summary ?? undefined,
              }
            : undefined,
          devex: devexContext,
        });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: planResult.sessionId,
          escalationReason: reason,
        };
      }

      // 6. Proceed with build
      console.log(`[ralph:worker:${this.repo}] Proceeding with build...`);
      const botBranch = getRepoBotBranch(this.repo);
      const proceedMessage = `Proceed with implementation. Target your PR to the \`${botBranch}\` branch.`;

      const pausedBuild = await this.pauseIfHardThrottled(task, "build", planResult.sessionId);
      if (pausedBuild) return pausedBuild;

      const buildRunLogPath = await this.recordRunLogPath(task, issueNumber, "build");

      let buildResult = await this.session.continueSession(taskRepoPath, planResult.sessionId, proceedMessage, {
        repo: this.repo,
        cacheKey,
        runLogPath: buildRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 4,
          stepTitle: "build",
        },
        ...this.buildWatchdogOptions(task, "build"),
        ...opencodeSessionOptions,
      });

      const pausedAfterBuild = await this.pauseIfHardThrottled(task, "build (post)", buildResult.sessionId || planResult.sessionId);
      if (pausedAfterBuild) return pausedAfterBuild;

      if (!buildResult.success) {
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "build", buildResult, opencodeXdg);
        }
        throw new Error(`Build failed: ${buildResult.output}`);
      }

      // Keep the latest session ID persisted
      if (buildResult.sessionId) {
        await this.queue.updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build", opencodeXdg);

      // 7. Extract PR URL (with retry loop if agent stopped without creating PR)
      // Also monitors for anomaly bursts (GPT tool-result-as-text loop)
      const MAX_CONTINUE_RETRIES = 5;
      let prUrl = extractPrUrlFromSession(buildResult);
      let prRecoveryDiagnostics = "";

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = recovered.diagnostics;
        prUrl = recovered.prUrl ?? prUrl;
      }

      let continueAttempts = 0;
      let anomalyAborts = 0;
      let lastAnomalyCount = 0;

      while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
        await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build", opencodeXdg);

        // Check for anomaly burst before continuing
        const anomalyStatus = await readLiveAnomalyCount(buildResult.sessionId);
        const newAnomalies = anomalyStatus.total - lastAnomalyCount;
        lastAnomalyCount = anomalyStatus.total;

        if (anomalyStatus.total >= ANOMALY_BURST_THRESHOLD || anomalyStatus.recentBurst) {
          anomalyAborts++;
          console.warn(
            `[ralph:worker:${this.repo}] Anomaly burst detected (${anomalyStatus.total} total, ${newAnomalies} new). ` +
            `Abort #${anomalyAborts}/${MAX_ANOMALY_ABORTS}`
          );

          if (anomalyAborts >= MAX_ANOMALY_ABORTS) {
            // Too many anomaly aborts - escalate
            const reason = `Agent stuck in tool-result-as-text loop (${anomalyStatus.total} anomalies detected, aborted ${anomalyAborts} times)`;
            console.log(`[ralph:worker:${this.repo}] Escalating due to repeated anomaly loops`);

            await this.queue.updateTaskStatus(task, "escalated");
            await this.notify.notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
              reason,
              escalationType: "other",
              planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
            });

            return {
              taskName: task.name,
              repo: this.repo,
              outcome: "escalated",
              sessionId: buildResult.sessionId,
              escalationReason: reason,
            };
          }

          // Send a specific nudge to break the loop
          console.log(`[ralph:worker:${this.repo}] Sending loop-break nudge...`);

          const pausedBuildLoopBreak = await this.pauseIfHardThrottled(task, "build loop-break", buildResult.sessionId);
          if (pausedBuildLoopBreak) return pausedBuildLoopBreak;

          const buildLoopBreakRunLogPath = await this.recordRunLogPath(task, issueNumber, "build loop-break");

          buildResult = await this.session.continueSession(
            taskRepoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            {
              repo: this.repo,
              cacheKey,
              runLogPath: buildLoopBreakRunLogPath,
              introspection: {
                repo: this.repo,
                issue: task.issue,
                taskName: task.name,
                step: 4,
                stepTitle: "build loop-break",
              },
              ...this.buildWatchdogOptions(task, "build-loop-break"),
              ...opencodeSessionOptions,
            }
          );

          const pausedBuildLoopBreakAfter = await this.pauseIfHardThrottled(task, "build loop-break (post)", buildResult.sessionId);
          if (pausedBuildLoopBreakAfter) return pausedBuildLoopBreakAfter;

          if (!buildResult.success) {
            if (buildResult.watchdogTimeout) {
              return await this.handleWatchdogTimeout(task, cacheKey, "build-loop-break", buildResult, opencodeXdg);
            }
            console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
            break;
          }

          // Reset anomaly tracking for fresh window
          lastAnomalyCount = anomalyStatus.total;
          prUrl = extractPrUrlFromSession(buildResult);
          continue;
        }

        continueAttempts++;
        console.log(
          `[ralph:worker:${this.repo}] No PR URL found; requesting PR creation (attempt ${continueAttempts}/${MAX_CONTINUE_RETRIES})`
        );

        const pausedBuildContinue = await this.pauseIfHardThrottled(task, "build continue", buildResult.sessionId);
        if (pausedBuildContinue) return pausedBuildContinue;

        const nudge = this.buildPrCreationNudge(botBranch, issueNumber, task.issue);
        const buildContinueRunLogPath = await this.recordRunLogPath(task, issueNumber, "build continue");

        buildResult = await this.session.continueSession(taskRepoPath, buildResult.sessionId, nudge, {
          repo: this.repo,
          cacheKey,
          runLogPath: buildContinueRunLogPath,
          timeoutMs: 10 * 60_000,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "build continue",
          },
          ...this.buildWatchdogOptions(task, "build-continue"),
          ...opencodeSessionOptions,
        });

        const pausedBuildContinueAfter = await this.pauseIfHardThrottled(task, "build continue (post)", buildResult.sessionId);
        if (pausedBuildContinueAfter) return pausedBuildContinueAfter;

        if (!buildResult.success) {
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "build-continue", buildResult, opencodeXdg);
          }

          // If the session ended without printing a URL, try to recover PR from git state.
          const recovered = await this.tryEnsurePrFromWorktree({
            task,
            issueNumber,
            issueTitle: issueMeta.title || task.name,
            botBranch,
          });
          prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
          prUrl = recovered.prUrl ?? prUrl;

          if (!prUrl) {
            console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
            break;
          }
        } else {
          prUrl = extractPrUrlFromSession(buildResult);
        }
      }

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
        prUrl = recovered.prUrl ?? prUrl;
      }

      if (!prUrl) {
        // Escalate if we still don't have a PR after retries
        const reason = `Agent completed but did not create a PR after ${continueAttempts} continue attempts`;
        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        await this.queue.updateTaskStatus(task, "escalated");
        await this.notify.notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
          reason,
          escalationType: "other",
          planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
        });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: buildResult.sessionId,
          escalationReason: reason,
        };
      }

      const pausedMerge = await this.pauseIfHardThrottled(task, "merge", buildResult.sessionId);
      if (pausedMerge) return pausedMerge;

      const mergeGate = await this.mergePrWithRequiredChecks({
        task,
        repoPath: taskRepoPath,
        cacheKey,
        botBranch,
        prUrl,
        sessionId: buildResult.sessionId,
        issueMeta,
        watchdogStagePrefix: "merge",
        notifyTitle: `Merging ${task.name}`,
        opencodeXdg,
      });

      if (!mergeGate.ok) return mergeGate.run;

      const pausedMergeAfter = await this.pauseIfHardThrottled(task, "merge (post)", mergeGate.sessionId || buildResult.sessionId);
      if (pausedMergeAfter) return pausedMergeAfter;

      prUrl = mergeGate.prUrl;
      buildResult.sessionId = mergeGate.sessionId;

      // 9. Run survey (configured command)
      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const pausedSurvey = await this.pauseIfHardThrottled(task, "survey", buildResult.sessionId);
      if (pausedSurvey) return pausedSurvey;

      const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
      const surveyRunLogPath = await this.recordRunLogPath(task, issueNumber, "survey");

      const surveyResult = await this.session.continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
        repo: this.repo,
        cacheKey,
        runLogPath: surveyRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 6,
          stepTitle: "survey",
        },
        ...this.buildWatchdogOptions(task, "survey"),
        ...opencodeSessionOptions,
      });

      const pausedSurveyAfter = await this.pauseIfHardThrottled(task, "survey (post)", surveyResult.sessionId || buildResult.sessionId);
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
        }
        console.warn(`[ralph:worker:${this.repo}] Survey may have failed: ${surveyResult.output}`);
      }

      // 10. Create agent-run note
      const endTime = new Date();
      await this.createAgentRun(task, {
        sessionId: buildResult.sessionId,
        pr: prUrl,
        outcome: "success",
        started: startTime,
        completed: endTime,
        surveyResults: surveyResult.output,
        devex: devexContext,
      });

      // 11. Mark task done
      await this.queue.updateTaskStatus(task, "done", {
        "completed-at": endTime.toISOString().split("T")[0],
        "session-id": "",
        "watchdog-retries": "",
        ...(worktreePath ? { "worktree-path": "" } : {}),
      });

      // 12. Cleanup per-task OpenCode cache on success
      await rm(this.session.getRalphXdgCacheHome(this.repo, cacheKey, opencodeXdg?.cacheHome), { recursive: true, force: true });

      if (worktreePath) {
        await this.cleanupGitWorktree(worktreePath);
      }

      // 13. Send desktop notification for completion
      await this.notify.notifyTaskComplete(task.name, this.repo, prUrl ?? undefined);

      console.log(`[ralph:worker:${this.repo}] Task completed: ${task.name}`);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "success",
        pr: prUrl ?? undefined,
        sessionId: buildResult.sessionId,
      };
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Task failed:`, error);

      await this.queue.updateTaskStatus(task, "blocked");
      await this.notify.notifyError(`Processing ${task.name}`, error?.message ?? String(error), task.name);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
    }
  }

  private async createAgentRun(
    task: AgentTask,
    data: {
      sessionId?: string;
      pr?: string | null;
      outcome: "success" | "throttled" | "escalated" | "failed";
      started: Date;
      completed: Date;
      surveyResults?: string;
      devex?: EscalationContext["devex"];
      bodyPrefix?: string;
    }
  ): Promise<void> {
    const vault = loadConfig().bwrbVault;
    const today = data.completed.toISOString().split("T")[0];
    const shortIssue = task.issue.split("/").pop() || task.issue;

    const runName = safeNoteName(`Run for ${shortIssue} - ${task.name.slice(0, 40)}`);

    const json = JSON.stringify({
      name: runName,
      task: `[[${task._name}]]`,  // Use _name (filename) not name (display) for wikilinks
      started: data.started.toISOString().split("T")[0],
      completed: today,
      outcome: data.outcome,
      pr: data.pr || "",
      "creation-date": today,
      scope: "builder",
    });

    try {
      const result = await $`bwrb new agent-run --json ${json}`.cwd(vault).quiet();
      const output = JSON.parse(result.stdout.toString());

        if (output.success && output.path) {
          const notePath = resolveVaultPath(output.path);
          const bodySections: string[] = [];

          if (data.bodyPrefix?.trim()) {
            bodySections.push(data.bodyPrefix.trim(), "");
          }

          // Add introspection summary if available
          if (data.sessionId) {
            const introspection = await readIntrospectionSummary(data.sessionId);
            if (introspection) {
              bodySections.push(
                "## Session Summary",
                "",
                `- **Steps:** ${introspection.stepCount}`,
                `- **Tool calls:** ${introspection.totalToolCalls}`,
                `- **Anomalies:** ${introspection.hasAnomalies ? `Yes (${introspection.toolResultAsTextCount} tool-result-as-text)` : "None"}`,
                `- **Recent tools:** ${introspection.recentTools.join(", ") || "none"}`,
                ""
              );
            }
          }


        // Add devex consult summary (if we used devex-before-escalate)
        if (data.devex?.consulted) {
          bodySections.push(
            "## Devex Consult",
            "",
            data.devex.sessionId ? `- **Session:** ${data.devex.sessionId}` : "",
            data.devex.summary ?? "",
            ""
          );
        }

        // Add survey results
        if (data.surveyResults) {
          bodySections.push("## Survey Results", "", data.surveyResults, "");
        }

        if (bodySections.length > 0) {
          await appendFile(notePath, "\n" + bodySections.join("\n"), "utf8");
        }

        // Clean up introspection logs
        if (data.sessionId) {
          await cleanupIntrospectionLogs(data.sessionId);
        }
      }

      console.log(`[ralph:worker:${this.repo}] Created agent-run note`);
    } catch (e) {
      console.error(`[ralph:worker:${this.repo}] Failed to create agent-run:`, e);
    }
  }
}
