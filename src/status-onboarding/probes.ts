import { access, constants } from "fs/promises";
import { dirname } from "path";
import { spawn } from "child_process";

import type { RepoConfig } from "../config";
import { computeRalphLabelSync } from "../github-labels";
import { GitHubApiError, GitHubClient, splitRepoFullName } from "../github/client";
import { resolveRequiredChecks } from "../github/required-checks";
import { getManagedOpencodeConfigManifest } from "../opencode-managed-config";
import { getRalphWorktreesDir } from "../paths";
import type { QueueBackendState } from "../queue-backend";
import { listRepoLabelWriteStates } from "../state";
import type { OnboardingCheckCandidate } from "./core";
import { evaluateRepoOnboarding, type RepoOnboardingEvaluation } from "./core";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_PER_REPO_TIMEOUT_MS = 4_000;
const DEFAULT_TOTAL_BUDGET_MS = 12_000;
const COMMAND_TIMEOUT_MS = 2_500;

type CommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms (${label})`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function runCommand(opts: { command: string; args: string[]; cwd?: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (buf) => {
      stdout += String(buf ?? "");
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf ?? "");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, stdout, stderr, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: error.message, timedOut: false });
    });
  });
}

function githubErrorToCandidate(params: {
  checkId: string;
  authFailureRemediation: string[];
  transientRemediation: string[];
  error: unknown;
}): OnboardingCheckCandidate {
  if (params.error instanceof GitHubApiError && [401, 403, 404].includes(params.error.status)) {
    return {
      checkId: params.checkId,
      status: "fail",
      reason: `GitHub permission error (HTTP ${params.error.status})`,
      remediation: params.authFailureRemediation,
    };
  }
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return {
    checkId: params.checkId,
    status: "unavailable",
    reason: `GitHub probe unavailable: ${message}`,
    remediation: params.transientRemediation,
  };
}

function unavailableRepo(repo: string, reason: string): RepoOnboardingEvaluation {
  return evaluateRepoOnboarding({
    repo,
    checks: [
      {
        checkId: "repo.access",
        status: "unavailable",
        reason,
        remediation: ["Re-run `bun run status` once GitHub and local probes are available."],
      },
    ],
  });
}

async function collectRepoCandidates(params: {
  repoConfig: RepoConfig;
  queueState: QueueBackendState;
  labelWriteBlockedUntilMs: number | null;
}): Promise<OnboardingCheckCandidate[]> {
  const candidates: OnboardingCheckCandidate[] = [];
  const repo = params.repoConfig.name;
  const { owner, name } = splitRepoFullName(repo);
  const github = new GitHubClient(repo);

  const repoPath = params.repoConfig.path;
  const worktreesDir = getRalphWorktreesDir();

  const repoRead = await github.requestWithLane<{ default_branch?: string | null }>(`/repos/${owner}/${name}`, {
    lane: "important",
    source: "status:onboarding:repo",
  });
  if (!repoRead.ok) {
    if ("deferred" in repoRead) {
      candidates.push({
        checkId: "repo.access",
        status: "unavailable",
        reason: `GitHub budget deferred until ${new Date(repoRead.deferred.untilTs).toISOString()}`,
        remediation: ["Wait for GitHub budget recovery, then re-run `bun run status`."],
      });
    } else {
      candidates.push(
        githubErrorToCandidate({
          checkId: "repo.access",
          error: repoRead.error,
          authFailureRemediation: [
            "Grant repo read access to Ralph GitHub auth and verify installation/token scopes.",
            "Re-run `bun run status --json` and confirm `repo.access` is `pass`.",
          ],
          transientRemediation: ["Re-run `bun run status` after transient GitHub failures clear."],
        })
      );
    }
  } else {
    const branch = repoRead.response.data?.default_branch?.trim() || "unknown";
    candidates.push({
      checkId: "repo.access",
      status: "pass",
      reason: `Repo metadata readable (default branch: ${branch})`,
      remediation: [],
    });
  }

  const labelsRead = await github.requestWithLane<Array<{ name?: string | null; color?: string | null; description?: string | null }>>(
    `/repos/${owner}/${name}/labels?per_page=100&page=1`,
    { lane: "important", source: "status:onboarding:labels" }
  );
  if (!labelsRead.ok) {
    if ("deferred" in labelsRead) {
      candidates.push({
        checkId: "labels.required_set",
        status: "unavailable",
        reason: `GitHub budget deferred until ${new Date(labelsRead.deferred.untilTs).toISOString()}`,
        remediation: ["Retry `bun run status` after GitHub budget cooldown."],
      });
    } else {
      candidates.push(
        githubErrorToCandidate({
          checkId: "labels.required_set",
          error: labelsRead.error,
          authFailureRemediation: [
            "Grant label read/write permission to Ralph GitHub auth.",
            "Restart daemon so label bootstrap can re-run, then re-check status.",
          ],
          transientRemediation: ["Re-run `bun run status` after GitHub API availability recovers."],
        })
      );
    }
  } else {
    const existing = Array.isArray(labelsRead.response.data)
      ? labelsRead.response.data.map((label) => ({
          name: label?.name ?? "",
          color: label?.color ?? null,
          description: label?.description ?? null,
        }))
      : [];
    const sync = computeRalphLabelSync(existing);
    if (sync.toCreate.length === 0 && sync.toUpdate.length === 0) {
      candidates.push({
        checkId: "labels.required_set",
        status: "pass",
        reason: "Required Ralph labels are present",
        remediation: [],
      });
    } else {
      const missing = sync.toCreate.map((item) => item.name).slice(0, 3);
      candidates.push({
        checkId: "labels.required_set",
        status: "fail",
        reason: `Missing/out-of-sync labels detected (${sync.toCreate.length} missing, ${sync.toUpdate.length} updates)` +
          (missing.length > 0 ? ` sample=${missing.join(", ")}` : ""),
        remediation: [
          "Ensure Ralph can manage labels, then let queue/bootstrap reconcile label specs.",
          "Re-run `bun run status` to confirm labels checklist is green.",
        ],
      });
    }
  }

  const gitRoot = await runCommand({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: repoPath,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (!gitRoot.ok) {
    candidates.push({
      checkId: "local.checkout_path",
      status: "fail",
      reason: `Repo path is not a readable git checkout (${repoPath})`,
      remediation: [
        `Ensure config repo path exists and is a valid checkout: ${repoPath}`,
        "Run `git rev-parse --show-toplevel` in the repo path and re-run status.",
      ],
    });
  } else {
    const dirty = await runCommand({
      command: "git",
      args: ["status", "--porcelain"],
      cwd: repoPath,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (!dirty.ok) {
      candidates.push({
        checkId: "local.checkout_path",
        status: "warn",
        reason: "Git checkout readable, but dirty-state probe failed",
        remediation: ["Run `git status --porcelain` locally and verify checkout health."],
      });
    } else if ((dirty.stdout ?? "").trim().length > 0) {
      candidates.push({
        checkId: "local.checkout_path",
        status: "warn",
        reason: "Local checkout is dirty",
        remediation: ["Keep base checkout clean to reduce setup surprises for new tasks."],
      });
    } else {
      candidates.push({
        checkId: "local.checkout_path",
        status: "pass",
        reason: "Local checkout exists and is clean",
        remediation: [],
      });
    }
  }

  try {
    await access(worktreesDir, constants.W_OK);
    candidates.push({
      checkId: "worktree.root_writable",
      status: "pass",
      reason: `Worktrees root writable (${worktreesDir})`,
      remediation: [],
    });
  } catch {
    try {
      await access(dirname(worktreesDir), constants.W_OK);
      candidates.push({
        checkId: "worktree.root_writable",
        status: "pass",
        reason: `Worktrees root missing but parent is writable (${worktreesDir})`,
        remediation: [],
      });
    } catch {
      candidates.push({
        checkId: "worktree.root_writable",
        status: "fail",
        reason: `Worktrees root is not writable (${worktreesDir})`,
        remediation: [
          `Grant write access for worktrees dir or set RALPH_WORKTREES_DIR to a writable path (${worktreesDir}).`,
        ],
      });
    }
  }

  const defaultBranch = repoRead.ok ? repoRead.response.data?.default_branch?.trim() || "main" : "main";
  const requiredChecks = await resolveRequiredChecks({
    override: Array.isArray(params.repoConfig.requiredChecks) ? params.repoConfig.requiredChecks : null,
    primaryBranch: params.repoConfig.botBranch,
    fallbackBranch: defaultBranch,
    fetchBranchProtection: async (branch) => {
      const path = `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`;
      const response = await github.requestWithLane<any>(path, {
        lane: "important",
        source: "status:onboarding:branch-protection",
        allowNotFound: true,
      });
      if (!response.ok) {
        if ("deferred" in response) {
          throw new Error(`deferred:${response.deferred.untilTs}`);
        }
        throw response.error;
      }
      return response.response.data;
    },
    logger: {
      warn: () => undefined,
      info: () => undefined,
    },
  }).catch((error) => {
    if (error instanceof Error && error.message.startsWith("deferred:")) {
      const untilTs = Number(error.message.slice("deferred:".length));
      if (Number.isFinite(untilTs)) {
        return { checks: [], source: "none" as const, branch: `deferred:${untilTs}` };
      }
    }
    if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status)) {
      return { checks: [], source: "none" as const, branch: "auth-error" };
    }
    return { checks: [], source: "none" as const, branch: "unavailable" };
  });

  if (requiredChecks.branch?.startsWith("deferred:")) {
    const untilTs = Number(requiredChecks.branch.slice("deferred:".length));
    candidates.push({
      checkId: "ci.required_checks_policy",
      status: "unavailable",
      reason: `Branch protection probe deferred until ${new Date(untilTs).toISOString()}`,
      remediation: ["Retry after GitHub budget cooldown."],
    });
  } else if (requiredChecks.branch === "auth-error") {
    candidates.push({
      checkId: "ci.required_checks_policy",
      status: "unavailable",
      reason: "Branch protection unreadable due to permissions",
      remediation: ["Grant branch protection read permission or configure explicit `requiredChecks`."],
    });
  } else if (requiredChecks.source === "config") {
    if (requiredChecks.checks.length > 0) {
      candidates.push({
        checkId: "ci.required_checks_policy",
        status: "pass",
        reason: `Required checks explicitly configured (${requiredChecks.checks.length})`,
        remediation: [],
      });
    } else {
      candidates.push({
        checkId: "ci.required_checks_policy",
        status: "warn",
        reason: "Required checks explicitly disabled for this repo",
        remediation: ["Set `repos[].requiredChecks` to enforce CI merge gating."],
      });
    }
  } else if (requiredChecks.source === "protection" && requiredChecks.checks.length > 0) {
    candidates.push({
      checkId: "ci.required_checks_policy",
      status: "pass",
      reason: `Derived ${requiredChecks.checks.length} required checks from branch protection`,
      remediation: [],
    });
  } else {
    candidates.push({
      checkId: "ci.required_checks_policy",
      status: "warn",
      reason: "No required checks discovered (fail-open policy in effect)",
      remediation: ["Configure `repos[].requiredChecks` or branch protection required checks for stricter gating."],
    });
  }

  const opencodeManifest = getManagedOpencodeConfigManifest();
  const missingFiles: string[] = [];
  for (const file of opencodeManifest.files) {
    try {
      await access(file.path, constants.R_OK);
    } catch {
      missingFiles.push(file.path);
    }
  }
  const opencodeBin = process.env.OPENCODE_BIN?.trim() || "opencode";
  const opencodeVersion = await runCommand({
    command: opencodeBin,
    args: ["--version"],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (missingFiles.length === 0 && opencodeVersion.ok) {
    candidates.push({
      checkId: "opencode.setup",
      status: "pass",
      reason: "Managed OpenCode config present and opencode binary available",
      remediation: [],
    });
  } else if (missingFiles.length > 0) {
    candidates.push({
      checkId: "opencode.setup",
      status: "fail",
      reason: `Managed OpenCode config incomplete (${missingFiles.length} files missing)`,
      remediation: ["Restart daemon to re-install managed OpenCode config."],
    });
  } else {
    candidates.push({
      checkId: "opencode.setup",
      status: "fail",
      reason: opencodeVersion.timedOut
        ? "OpenCode binary probe timed out"
        : `OpenCode binary unavailable (${opencodeVersion.stderr.trim() || "not found"})`,
      remediation: ["Install `opencode` or set OPENCODE_BIN to a valid executable path."],
    });
  }

  const blockedSuffix =
    typeof params.labelWriteBlockedUntilMs === "number" && params.labelWriteBlockedUntilMs > Date.now()
      ? `label writes blocked until ${new Date(params.labelWriteBlockedUntilMs).toISOString()}`
      : null;
  if (params.queueState.health !== "ok") {
    candidates.push({
      checkId: "github.degraded_mode",
      status: "warn",
      reason: blockedSuffix
        ? `GitHub queue degraded (${blockedSuffix})`
        : `GitHub queue health is ${params.queueState.health}`,
      remediation: ["Wait for GitHub API budget recovery; status will converge automatically."],
    });
  } else {
    candidates.push({
      checkId: "github.degraded_mode",
      status: blockedSuffix ? "warn" : "pass",
      reason: blockedSuffix ? blockedSuffix : "GitHub queue health is normal",
      remediation: blockedSuffix ? ["Re-run status after cooldown expires."] : [],
    });
  }

  return candidates;
}

export async function collectOnboardingEvaluations(params: {
  repos: RepoConfig[];
  queueState: QueueBackendState;
  concurrency?: number;
  perRepoTimeoutMs?: number;
  totalBudgetMs?: number;
}): Promise<RepoOnboardingEvaluation[]> {
  const repos = [...params.repos].sort((a, b) => a.name.localeCompare(b.name));
  const results: RepoOnboardingEvaluation[] = [];
  const concurrency = Math.max(1, Math.floor(params.concurrency ?? DEFAULT_CONCURRENCY));
  const perRepoTimeoutMs = params.perRepoTimeoutMs ?? DEFAULT_PER_REPO_TIMEOUT_MS;
  const totalBudgetMs = params.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const startedAt = Date.now();
  const blockedByRepo = new Map(
    listRepoLabelWriteStates().map((state) => [state.repo, state.blockedUntilMs ?? null] as const)
  );

  let index = 0;
  const next = async (): Promise<void> => {
    const current = index;
    index += 1;
    if (current >= repos.length) return;
    const repoConfig = repos[current]!;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= totalBudgetMs) {
      results[current] = unavailableRepo(repoConfig.name, "Onboarding budget exceeded");
      await next();
      return;
    }

    try {
      const candidates = await withTimeout(
        collectRepoCandidates({
          repoConfig,
          queueState: params.queueState,
          labelWriteBlockedUntilMs: blockedByRepo.get(repoConfig.name) ?? null,
        }),
        perRepoTimeoutMs,
        `onboarding:${repoConfig.name}`
      );
      results[current] = evaluateRepoOnboarding({ repo: repoConfig.name, checks: candidates });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results[current] = unavailableRepo(repoConfig.name, `Onboarding probes failed: ${reason}`);
    }

    await next();
  };

  const workers = Array.from({ length: Math.min(concurrency, repos.length) }, () => next());
  await Promise.all(workers);
  return results.filter(Boolean);
}

export function collectUnavailableOnboardingEvaluations(repos: RepoConfig[], reason: string): RepoOnboardingEvaluation[] {
  return [...repos]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((repo) => unavailableRepo(repo.name, reason));
}
