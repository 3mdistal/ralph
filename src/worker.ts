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
import { getRepoBotBranch, getRepoMaxWorkers, loadConfig } from "./config";
import { continueCommand, continueSession, getRalphXdgCacheHome, runCommand, type SessionResult } from "./session";
import { getThrottleDecision } from "./throttle";
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
import { getRalphSessionsDir, getRalphWorktreesDir } from "./paths";
import {
  parseGitWorktreeListPorcelain,
  pickWorktreeForIssue,
  stripHeadsRef,
  type GitWorktreeEntry,
} from "./git-worktree";

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

export class RepoWorker {
  constructor(public readonly repo: string, public readonly repoPath: string) {}

  private ensureLabelsPromise: Promise<void> | null = null;

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
    try {
      const list = await $`git worktree list --porcelain`.cwd(this.repoPath).quiet();
      const out = list.stdout.toString();
      if (out.includes(`worktree ${worktreePath}\n`)) return;
    } catch {
      // ignore and attempt create
    }

    await mkdir(dirname(worktreePath), { recursive: true });

    const ref = await this.resolveWorktreeRef();
    try {
      await $`git worktree add --detach ${worktreePath} ${ref}`.cwd(this.repoPath).quiet();
    } catch (e: any) {
      // If it already exists, treat as best-effort reuse.
      if (existsSync(worktreePath)) {
        console.warn(`[ralph:worker:${this.repo}] Failed to add worktree; reusing existing path: ${worktreePath}`);
        return;
      }
      throw e;
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
    await updateTaskStatus(task, "starting", { "worktree-path": worktreePath });

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

      return {
        labels: data.labels?.map((l: any) => l.name) ?? [],
        title: data.title ?? "",
        state: typeof data.state === "string" ? data.state : undefined,
        stateReason: typeof data.stateReason === "string" ? data.stateReason : undefined,
        closedAt: typeof data.closedAt === "string" ? data.closedAt : undefined,
        url: typeof data.url === "string" ? data.url : undefined,
      };
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

    await updateTaskStatus(task, "done", {
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

  private async pauseIfHardThrottled(task: AgentTask, stage: string, sessionId?: string): Promise<AgentRun | null> {
    const decision = await getThrottleDecision();
    if (decision.state !== "hard") return null;

    const throttledAt = new Date().toISOString();
    const resumeAt = decision.resumeAtTs ? new Date(decision.resumeAtTs).toISOString() : "";
    const sid = sessionId?.trim() || task["session-id"]?.trim() || "";

    const extraFields: Record<string, string> = {
      "throttled-at": throttledAt,
      "resume-at": resumeAt,
      "usage-snapshot": JSON.stringify(decision.snapshot),
    };

    if (sid) extraFields["session-id"] = sid;

    await updateTaskStatus(task, "throttled", extraFields);

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

  private async drainNudges(task: AgentTask, repoPath: string, sessionId: string, cacheKey: string, stage: string): Promise<void> {
    const sid = sessionId?.trim();
    if (!sid) return;

    try {
      const result = await drainQueuedNudges(sid, async (message) => {
        const paused = await this.pauseIfHardThrottled(task, `nudge-${stage}`, sid);
        if (paused) {
          return { success: false, error: "hard throttled" };
        }

        const res = await continueSession(repoPath, sid, message, {
          repo: this.repo,
          cacheKey,
          ...this.buildWatchdogOptions(task, `nudge-${stage}`),
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

  private async handleWatchdogTimeout(task: AgentTask, cacheKey: string, stage: string, result: SessionResult): Promise<AgentRun> {
    const timeout = result.watchdogTimeout;
    const retryCount = this.getWatchdogRetryCount(task);
    const nextRetryCount = retryCount + 1;

    const reason = timeout
      ? `Tool call timed out: ${timeout.toolName} ${timeout.callId} after ${Math.round(timeout.elapsedMs / 1000)}s (${stage})`
      : `Tool call timed out (${stage})`;

    // Cleanup per-task OpenCode cache on watchdog timeouts (best-effort)
    try {
      await rm(getRalphXdgCacheHome(this.repo, cacheKey), { recursive: true, force: true });
    } catch {
      // ignore
    }

    if (retryCount === 0) {
      console.warn(`[ralph:worker:${this.repo}] Watchdog hard timeout; re-queuing once for recovery: ${reason}`);
      await updateTaskStatus(task, "queued", {
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

    await updateTaskStatus(task, "escalated", escalationFields);

    await notifyEscalation({
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

    const issueMeta = await this.getIssueMetadata(task.issue);
    if (issueMeta.state === "CLOSED") {
      return await this.skipClosedIssue(task, issueMeta, startTime);
    }

    await this.ensureBaselineLabelsOnce();

    const issueMatch = task.issue.match(/#(\d+)$/);
    const issueNumber = issueMatch?.[1] ?? "";
    const cacheKey = issueNumber || task._name;

    const { repoPath: taskRepoPath, worktreePath } = await this.resolveTaskRepoPath(task, issueNumber || cacheKey, "resume");

      const existingSessionId = task["session-id"]?.trim();
      if (!existingSessionId) {
        const reason = "In-progress task has no session-id; cannot resume";
        console.warn(`[ralph:worker:${this.repo}] ${reason}: ${task.name}`);
        await updateTaskStatus(task, "starting", { "session-id": "" });
        return { taskName: task.name, repo: this.repo, outcome: "failed", escalationReason: reason };
      }


    try {
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

      let buildResult = await continueSession(taskRepoPath, existingSessionId, resumeMessage, {
        repo: this.repo,
        cacheKey,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 4,
          stepTitle: "resume",
        },
        ...this.buildWatchdogOptions(task, "resume"),
      });

      const pausedAfter = await this.pauseIfHardThrottled(task, "resume (post)", buildResult.sessionId || existingSessionId);
      if (pausedAfter) return pausedAfter;

      if (!buildResult.success) {
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume", buildResult);
        }

        const reason = `Failed to resume OpenCode session ${existingSessionId}: ${buildResult.output}`;
        console.warn(`[ralph:worker:${this.repo}] Resume failed; falling back to fresh run: ${reason}`);

        // Fall back to a fresh run by clearing session-id and re-queueing.
        await updateTaskStatus(task, "queued", { "session-id": "" });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: existingSessionId,
          escalationReason: reason,
        };
      }

      if (buildResult.sessionId) {
        await updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume");

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
        await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume");

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

            await updateTaskStatus(task, "escalated");
            await notifyEscalation({
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

          buildResult = await continueSession(
            taskRepoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            {
              repo: this.repo,
              cacheKey,
              introspection: {
                repo: this.repo,
                issue: task.issue,
                taskName: task.name,
                step: 4,
                stepTitle: "resume loop-break",
              },
              ...this.buildWatchdogOptions(task, "resume-loop-break"),
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
              return await this.handleWatchdogTimeout(task, cacheKey, "resume-loop-break", buildResult);
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
        buildResult = await continueSession(taskRepoPath, buildResult.sessionId, nudge, {
          repo: this.repo,
          cacheKey,
          timeoutMs: 10 * 60_000,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "continue",
          },
          ...this.buildWatchdogOptions(task, "resume-continue"),
        });

        const pausedContinueAfter = await this.pauseIfHardThrottled(
          task,
          "resume continue (post)",
          buildResult.sessionId || existingSessionId
        );
        if (pausedContinueAfter) return pausedContinueAfter;

        if (!buildResult.success) {
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "resume-continue", buildResult);
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

        await updateTaskStatus(task, "escalated");
        await notifyEscalation({
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

      console.log(`[ralph:worker:${this.repo}] Approving merge for ${prUrl}`);

      const pausedMerge = await this.pauseIfHardThrottled(task, "resume merge", buildResult.sessionId || existingSessionId);
      if (pausedMerge) return pausedMerge;

      const mergeResult = await continueSession(
        taskRepoPath,
        buildResult.sessionId,
        "Looks good. Merge the PR. (Don’t delete branches/worktrees; Ralph will clean up.)",
        {
          repo: this.repo,
          cacheKey,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 5,
            stepTitle: "merge",
          },
          ...this.buildWatchdogOptions(task, "resume-merge"),
        }
      );

      const pausedMergeAfter = await this.pauseIfHardThrottled(task, "resume merge (post)", mergeResult.sessionId || buildResult.sessionId || existingSessionId);
      if (pausedMergeAfter) return pausedMergeAfter;

      if (!mergeResult.success) {
        if (mergeResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume-merge", mergeResult);
        }
        console.warn(`[ralph:worker:${this.repo}] Merge may have failed: ${mergeResult.output}`);
      }

      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const pausedSurvey = await this.pauseIfHardThrottled(task, "resume survey", buildResult.sessionId || existingSessionId);
      if (pausedSurvey) return pausedSurvey;

      const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
      const surveyResult = await continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
        repo: this.repo,
        cacheKey,
        ...this.buildWatchdogOptions(task, "resume-survey"),
      });

      const pausedSurveyAfter = await this.pauseIfHardThrottled(task, "resume survey (post)", surveyResult.sessionId || buildResult.sessionId || existingSessionId);
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume-survey", surveyResult);
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

      await updateTaskStatus(task, "done", {
        "completed-at": endTime.toISOString().split("T")[0],
        "session-id": "",
        "watchdog-retries": "",
        ...(worktreePath ? { "worktree-path": "" } : {}),
      });

      // Cleanup per-task OpenCode cache on success
      await rm(getRalphXdgCacheHome(this.repo, cacheKey), { recursive: true, force: true });

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

      await updateTaskStatus(task, "blocked");
      await notifyError(`Resuming ${task.name}`, error?.message ?? String(error), task.name);

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

      // 2. Preflight: skip work if the upstream issue is already CLOSED
      const issueMeta = await this.getIssueMetadata(task.issue);
      if (issueMeta.state === "CLOSED") {
        return await this.skipClosedIssue(task, issueMeta, startTime);
      }

      const pausedPreStart = await this.pauseIfHardThrottled(task, "pre-start");
      if (pausedPreStart) return pausedPreStart;

      // 3. Mark task starting (restart-safe pre-session state)
      const markedStarting = await updateTaskStatus(task, "starting", {
        "assigned-at": startTime.toISOString().split("T")[0],
      });
      if (!markedStarting) {
        throw new Error("Failed to mark task starting (bwrb edit failed)");
      }

      await this.ensureBaselineLabelsOnce();

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

      let planResult = await runCommand(taskRepoPath, "next-task", [issueNumber], {
        repo: this.repo,
        cacheKey,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 1,
          stepTitle: "next-task",
        },
        ...this.buildWatchdogOptions(task, "next-task"),
      });

      const pausedAfterNextTask = await this.pauseIfHardThrottled(task, "next-task (post)", planResult.sessionId);
      if (pausedAfterNextTask) return pausedAfterNextTask;

      if (!planResult.success && planResult.watchdogTimeout) {
        return await this.handleWatchdogTimeout(task, cacheKey, "next-task", planResult);
      }

      if (!planResult.success && isTransientCacheENOENT(planResult.output)) {
        console.warn(`[ralph:worker:${this.repo}] /next-task hit transient cache ENOENT; retrying once...`);
        await new Promise((r) => setTimeout(r, 750));
        planResult = await runCommand(taskRepoPath, "next-task", [issueNumber], {
          repo: this.repo,
          cacheKey,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 1,
            stepTitle: "next-task (retry)",
          },
          ...this.buildWatchdogOptions(task, "next-task-retry"),
        });
      }

      const pausedAfterNextTaskRetry = await this.pauseIfHardThrottled(task, "next-task (post retry)", planResult.sessionId);
      if (pausedAfterNextTaskRetry) return pausedAfterNextTaskRetry;

      if (!planResult.success) {
        if (planResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "next-task", planResult);
        }
        throw new Error(`/next-task failed: ${planResult.output}`);
      }

      // Persist OpenCode session ID for crash recovery
      if (planResult.sessionId) {
        await updateTaskStatus(task, "in-progress", { "session-id": planResult.sessionId });
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

        const devexResult = await continueSession(taskRepoPath, baseSessionId, devexPrompt, {
          agent: "devex",
          repo: this.repo,
          cacheKey,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 2,
            stepTitle: "consult devex",
          },
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
            "If an open question touches contract surfaces (CLI flags, exit codes, stdout/stderr formats, public error strings, config/schema, machine-readable JSON), set decision=escalate.",
            "",
            "Devex guidance:",
            devexSummary || devexResult.output,
          ].join("\n");

          const pausedReroute = await this.pauseIfHardThrottled(task, "reroute after devex", baseSessionId);
          if (pausedReroute) return pausedReroute;

          const rerouteResult = await continueSession(taskRepoPath, baseSessionId, reroutePrompt, {
            repo: this.repo,
            cacheKey,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 3,
              stepTitle: "reroute after devex",
            },
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
              await updateTaskStatus(task, "in-progress", { "session-id": rerouteResult.sessionId });
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

        await updateTaskStatus(task, "escalated");
        await notifyEscalation({
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

      let buildResult = await continueSession(taskRepoPath, planResult.sessionId, proceedMessage, {
        repo: this.repo,
        cacheKey,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 4,
          stepTitle: "build",
        },
        ...this.buildWatchdogOptions(task, "build"),
      });

      const pausedAfterBuild = await this.pauseIfHardThrottled(task, "build (post)", buildResult.sessionId || planResult.sessionId);
      if (pausedAfterBuild) return pausedAfterBuild;

      if (!buildResult.success) {
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "build", buildResult);
        }
        throw new Error(`Build failed: ${buildResult.output}`);
      }

      // Keep the latest session ID persisted
      if (buildResult.sessionId) {
        await updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build");

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
        await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build");

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

            await updateTaskStatus(task, "escalated");
            await notifyEscalation({
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

          buildResult = await continueSession(
            taskRepoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            {
              repo: this.repo,
              cacheKey,
              introspection: {
                repo: this.repo,
                issue: task.issue,
                taskName: task.name,
                step: 4,
                stepTitle: "build loop-break",
              },
              ...this.buildWatchdogOptions(task, "build-loop-break"),
            }
          );

          const pausedBuildLoopBreakAfter = await this.pauseIfHardThrottled(task, "build loop-break (post)", buildResult.sessionId);
          if (pausedBuildLoopBreakAfter) return pausedBuildLoopBreakAfter;

          if (!buildResult.success) {
            if (buildResult.watchdogTimeout) {
              return await this.handleWatchdogTimeout(task, cacheKey, "build-loop-break", buildResult);
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
        buildResult = await continueSession(taskRepoPath, buildResult.sessionId, nudge, {
          repo: this.repo,
          cacheKey,
          timeoutMs: 10 * 60_000,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "build continue",
          },
          ...this.buildWatchdogOptions(task, "build-continue"),
        });

        const pausedBuildContinueAfter = await this.pauseIfHardThrottled(task, "build continue (post)", buildResult.sessionId);
        if (pausedBuildContinueAfter) return pausedBuildContinueAfter;

        if (!buildResult.success) {
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "build-continue", buildResult);
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

        await updateTaskStatus(task, "escalated");
        await notifyEscalation({
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

      // 8. Ask agent to merge
      if (prUrl) {
        console.log(`[ralph:worker:${this.repo}] Approving merge for ${prUrl}`);

        const pausedMerge = await this.pauseIfHardThrottled(task, "merge", buildResult.sessionId);
        if (pausedMerge) return pausedMerge;

        const mergeResult = await continueSession(
          taskRepoPath,
          buildResult.sessionId,
          "Looks good. Merge the PR. (Don’t delete branches/worktrees; Ralph will clean up.)",
          {
            repo: this.repo,
            cacheKey,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 5,
              stepTitle: "merge",
            },
            ...this.buildWatchdogOptions(task, "merge"),
          }
        );

        const pausedMergeAfter = await this.pauseIfHardThrottled(task, "merge (post)", mergeResult.sessionId || buildResult.sessionId);
        if (pausedMergeAfter) return pausedMergeAfter;

        if (!mergeResult.success) {
          if (mergeResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "merge", mergeResult);
          }
          console.warn(`[ralph:worker:${this.repo}] Merge may have failed: ${mergeResult.output}`);
        }
      }

      // 9. Run survey (configured command)
      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const pausedSurvey = await this.pauseIfHardThrottled(task, "survey", buildResult.sessionId);
      if (pausedSurvey) return pausedSurvey;

      const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
      const surveyResult = await continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
        repo: this.repo,
        cacheKey,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 6,
          stepTitle: "survey",
        },
        ...this.buildWatchdogOptions(task, "survey"),
      });

      const pausedSurveyAfter = await this.pauseIfHardThrottled(task, "survey (post)", surveyResult.sessionId || buildResult.sessionId);
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult);
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
      await updateTaskStatus(task, "done", {
        "completed-at": endTime.toISOString().split("T")[0],
        "session-id": "",
        "watchdog-retries": "",
        ...(worktreePath ? { "worktree-path": "" } : {}),
      });

      // 12. Cleanup per-task OpenCode cache on success
      await rm(getRalphXdgCacheHome(this.repo, cacheKey), { recursive: true, force: true });

      if (worktreePath) {
        await this.cleanupGitWorktree(worktreePath);
      }

      // 13. Send desktop notification for completion
      await notifyTaskComplete(task.name, this.repo, prUrl ?? undefined);

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

      await updateTaskStatus(task, "blocked");
      await notifyError(`Processing ${task.name}`, error?.message ?? String(error), task.name);

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
