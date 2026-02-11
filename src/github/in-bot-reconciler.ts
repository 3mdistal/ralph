import type { RepoConfig } from "../config";
import { shouldLog } from "../logging";
import {
  clearRepoGithubInBotPendingIssues,
  clearTaskExecutionStateForIssue,
  deleteRepoGithubInBotPendingIssue,
  getRepoGithubInBotReconcileCursor,
  getRepoLabelSchemeState,
  listRepoGithubInBotPendingIssues,
  recordRepoGithubInBotReconcileCursor,
  upsertRepoGithubInBotPendingIssue,
  type RepoGithubInBotCursor,
  type RepoGithubInBotPendingIssue,
} from "../state";
import { isRepoAllowed } from "../github-app-auth";
import { createRalphWorkflowLabelsEnsurer, ensureRalphWorkflowLabelsOnce, type EnsureOutcome } from "./ensure-ralph-workflow-labels";
import { executeIssueLabelOps, planIssueLabelOps } from "./issue-label-io";
import { GitHubClient, splitRepoFullName } from "./client";
import { RALPH_LABEL_STATUS_DONE, RALPH_LABEL_STATUS_IN_BOT } from "../github-labels";

type PollerHandle = { stop: () => void };
type TimeoutHandle = ReturnType<typeof setTimeout>;
type EnsureLabels = (repo: string) => Promise<EnsureOutcome>;
type GraphQlResponse<T> = { data?: T; errors?: Array<{ message?: string | null }> };

type ClosingIssue = {
  number: number;
  url: string;
  state: string;
  labels: string[];
};

type MergedPullRequest = {
  number: number;
  url: string;
  mergedAt: string;
  closingIssues: ClosingIssue[];
};

type InBotReconcileResult = {
  ok: boolean;
  processedPrs: number;
  updatedIssues: number;
  pendingAdded: number;
  pendingResolved: number;
  localClears: number;
  error?: string;
  initializedCursor?: boolean;
  resetCursor?: boolean;
};

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PRS_PER_RUN = 200;
const DEFAULT_MAX_PENDING_PER_RUN = 50;
const DEFAULT_BACKOFF_MULTIPLIER = 1.5;
const DEFAULT_ERROR_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MULTIPLIER = 10;
const MIN_DELAY_MS = 1000;
const IDLE_LOG_INTERVAL_MS = 60_000;

const IN_BOT_LABEL = RALPH_LABEL_STATUS_IN_BOT;
const TERMINAL_STATUS_LABELS = [RALPH_LABEL_STATUS_DONE, RALPH_LABEL_STATUS_IN_BOT];
const TRANSITION_LABELS = [
  "ralph:status:queued",
  "ralph:status:in-progress",
  "ralph:status:paused",
  "ralph:status:escalated",
  "ralph:status:stopped",
];

function applyJitter(valueMs: number): number {
  const clamped = Math.max(valueMs, MIN_DELAY_MS);
  const variance = clamped * 0.2;
  const delta = (Math.random() * 2 - 1) * variance;
  return Math.max(MIN_DELAY_MS, Math.round(clamped + delta));
}

function nextDelayMs(params: {
  baseMs: number;
  previousMs: number;
  hadError: boolean;
}): number {
  const multiplier = params.hadError ? DEFAULT_ERROR_MULTIPLIER : DEFAULT_BACKOFF_MULTIPLIER;
  const next = params.previousMs * multiplier;
  return Math.min(next, params.baseMs * DEFAULT_MAX_BACKOFF_MULTIPLIER);
}

function resolveDelay(params: {
  baseMs: number;
  previousMs: number;
  hadError: boolean;
  hadWork: boolean;
}): { delayMs: number; reason: "work" | "idle" | "error" } {
  if (params.hadError) {
    return { delayMs: nextDelayMs({ baseMs: params.baseMs, previousMs: params.previousMs, hadError: true }), reason: "error" };
  }
  if (params.hadWork) {
    return { delayMs: params.baseMs, reason: "work" };
  }
  return {
    delayMs: nextDelayMs({ baseMs: params.baseMs, previousMs: params.previousMs, hadError: false }),
    reason: "idle",
  };
}

function parseIsoMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGitRef(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, "");
}

function parseRepoFromIssueUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

function hasRalphLabel(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase().startsWith("ralph:"));
}

function hasTerminalStatus(labels: string[]): boolean {
  return TERMINAL_STATUS_LABELS.some((label) => labels.includes(label));
}

function selectUnprocessedMergedPrs(prs: MergedPullRequest[], cursor: RepoGithubInBotCursor): MergedPullRequest[] {
  const cursorMs = parseIsoMs(cursor.lastMergedAt) ?? 0;
  return prs
    .filter((pr) => {
      const mergedMs = parseIsoMs(pr.mergedAt);
      if (mergedMs === null) return false;
      if (mergedMs < cursorMs) return false;
      if (mergedMs === cursorMs && pr.number <= cursor.lastPrNumber) return false;
      return true;
    })
    .sort((a, b) => {
      const aMs = parseIsoMs(a.mergedAt) ?? 0;
      const bMs = parseIsoMs(b.mergedAt) ?? 0;
      if (aMs !== bMs) return aMs - bMs;
      return a.number - b.number;
    });
}

async function graphqlRequest<T>(github: GitHubClient, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await github.request<GraphQlResponse<T>>("/graphql", {
    method: "POST",
    body: { query, variables },
  });
  const payload = response.data;
  if (!payload) {
    throw new Error("GraphQL response missing payload");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GraphQL: ${payload.errors[0]?.message ?? "Unknown error"}`);
  }
  return payload.data ?? ({} as T);
}

async function fetchIssueStateAndLabels(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
}): Promise<{ state: string; labels: string[] } | null> {
  const { owner, name } = splitRepoFullName(params.repo);
  try {
    const response = await params.github.request<{
      state?: string | null;
      labels?: Array<{ name?: string | null }> | null;
    }>(`/repos/${owner}/${name}/issues/${params.issueNumber}`);
    const issue = response.data;
    if (!issue) return null;
    const labels = (issue.labels ?? [])
      .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
      .filter(Boolean);
    return { state: String(issue.state ?? ""), labels };
  } catch {
    return null;
  }
}

async function fetchMergedPullRequests(params: {
  github: GitHubClient;
  repo: string;
  botBranch: string;
  since: string;
}): Promise<MergedPullRequest[]> {
  const { owner, name } = splitRepoFullName(params.repo);
  const query = `repo:${owner}/${name} is:pr is:merged base:${params.botBranch} merged:>=${params.since}`;
  const results: MergedPullRequest[] = [];
  let after: string | null = null;

  for (;;) {
    const data: {
      search?: {
        nodes?: Array<{
          __typename?: string | null;
          number?: number | null;
          url?: string | null;
          mergedAt?: string | null;
          closingIssuesReferences?: {
            nodes?: Array<{
              number?: number | null;
              url?: string | null;
              state?: string | null;
              labels?: { nodes?: Array<{ name?: string | null }> } | null;
            }>;
          } | null;
        }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    } = await graphqlRequest(
      params.github,
      `query($query: String!, $after: String) {
        search(type: ISSUE, query: $query, first: ${DEFAULT_PAGE_SIZE}, after: $after) {
          nodes {
            __typename
            ... on PullRequest {
              number
              url
              mergedAt
              closingIssuesReferences(first: 50) {
                nodes {
                  number
                  url
                  state
                  labels(first: 50) {
                    nodes { name }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { query, after }
    );

    const nodes = data.search?.nodes ?? [];
    for (const node of nodes) {
      if (node?.__typename !== "PullRequest") continue;
      const number = typeof node.number === "number" ? node.number : null;
      const url = typeof node.url === "string" ? node.url : null;
      const mergedAt = typeof node.mergedAt === "string" ? node.mergedAt : null;
      if (!number || !url || !mergedAt) continue;

      const closingIssues = (node.closingIssuesReferences?.nodes ?? [])
        .map((issue) => {
          const issueNumber = typeof issue?.number === "number" ? issue.number : null;
          const issueUrl = typeof issue?.url === "string" ? issue.url : null;
          if (!issueNumber || !issueUrl) return null;
          const labels = (issue?.labels?.nodes ?? [])
            .map((label) => (typeof label?.name === "string" ? label.name.trim() : ""))
            .filter(Boolean);
          return {
            number: issueNumber,
            url: issueUrl,
            state: String(issue?.state ?? ""),
            labels,
          } satisfies ClosingIssue;
        })
        .filter(Boolean) as ClosingIssue[];

      results.push({ number, url, mergedAt, closingIssues });
    }

    const pageInfo = data.search?.pageInfo ?? {};
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }

  return results;
}

async function reconcilePendingIssue(params: {
  github: GitHubClient;
  repo: RepoConfig;
  pending: RepoGithubInBotPendingIssue;
  log: (message: string) => void;
  warn: (message: string) => void;
}): Promise<{ resolved: boolean; localCleared: boolean }> {
  const prefix = `[ralph:in-bot:${params.repo.name}]`;
  const issue = await fetchIssueStateAndLabels({ github: params.github, repo: params.repo.name, issueNumber: params.pending.issueNumber });
  if (!issue) {
    upsertRepoGithubInBotPendingIssue({
      repo: params.repo.name,
      repoPath: params.repo.path,
      botBranch: params.repo.botBranch,
      issueNumber: params.pending.issueNumber,
      prNumber: params.pending.prNumber,
      prUrl: params.pending.prUrl,
      mergedAt: params.pending.mergedAt,
      attemptError: "issue-fetch-failed",
    });
    return { resolved: false, localCleared: false };
  }

  const cleared = clearTaskExecutionStateForIssue({
    repo: params.repo.name,
    issueNumber: params.pending.issueNumber,
    status: "done",
    reason: `in-bot-reconciler:pending#${params.pending.prNumber}`,
  });
  if (cleared.hadActiveOwner) {
    params.warn(`${prefix} Pending replay found active ownership for #${params.pending.issueNumber}; cleared local task state.`);
  }

  if (issue.state.toUpperCase() !== "OPEN" || hasTerminalStatus(issue.labels) || !hasRalphLabel(issue.labels)) {
    deleteRepoGithubInBotPendingIssue({
      repo: params.repo.name,
      issueNumber: params.pending.issueNumber,
      prNumber: params.pending.prNumber,
    });
    return { resolved: true, localCleared: cleared.updated };
  }

  const ops = planIssueLabelOps({ add: [IN_BOT_LABEL], remove: TRANSITION_LABELS });
  const result = await executeIssueLabelOps({
    github: params.github,
    repo: params.repo.name,
    issueNumber: params.pending.issueNumber,
    ops,
    log: (message) => params.log(`${prefix} ${message}`),
    logLabel: `${params.repo.name}#${params.pending.issueNumber}`,
  });
  if (!result.ok) {
    upsertRepoGithubInBotPendingIssue({
      repo: params.repo.name,
      repoPath: params.repo.path,
      botBranch: params.repo.botBranch,
      issueNumber: params.pending.issueNumber,
      prNumber: params.pending.prNumber,
      prUrl: params.pending.prUrl,
      mergedAt: params.pending.mergedAt,
      attemptError: `label-update:${result.kind}`,
    });
    return { resolved: false, localCleared: cleared.updated };
  }

  deleteRepoGithubInBotPendingIssue({
    repo: params.repo.name,
    issueNumber: params.pending.issueNumber,
    prNumber: params.pending.prNumber,
  });
  return { resolved: true, localCleared: cleared.updated };
}

export async function reconcileRepoInBotState(params: {
  repo: RepoConfig;
  github: GitHubClient;
  now?: () => Date;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  maxPrsPerRun?: number;
  maxPendingPerRun?: number;
  ensureLabels?: EnsureLabels;
}): Promise<InBotReconcileResult> {
  const log = params.log ?? ((message: string) => console.log(message));
  const warn = params.warn ?? ((message: string) => console.warn(message));
  const now = params.now ?? (() => new Date());
  const repo = params.repo.name;
  const maxPrs = params.maxPrsPerRun ?? DEFAULT_MAX_PRS_PER_RUN;
  const maxPending = params.maxPendingPerRun ?? DEFAULT_MAX_PENDING_PER_RUN;
  const prefix = `[ralph:in-bot:${repo}]`;
  const ensureLabels =
    params.ensureLabels ??
    (async (targetRepo: string) => ensureRalphWorkflowLabelsOnce({ repo: targetRepo, github: params.github }));

  if (!isRepoAllowed(repo)) {
    log(`${prefix} Skipping repo (owner not in allowlist)`);
    return { ok: true, processedPrs: 0, updatedIssues: 0, pendingAdded: 0, pendingResolved: 0, localClears: 0 };
  }

  const scheme = getRepoLabelSchemeState(repo);
  if (scheme.errorCode === "legacy-workflow-labels") {
    log(`${prefix} Repo unschedulable due to legacy workflow labels; skipping in-bot reconciler. See docs/ops/label-scheme-migration.md`);
    return { ok: true, processedPrs: 0, updatedIssues: 0, pendingAdded: 0, pendingResolved: 0, localClears: 0 };
  }

  const labelOutcome = await ensureLabels(repo);
  if (!labelOutcome.ok) {
    const key = `ralph:in-bot:labels:${repo}`;
    if (shouldLog(key, 60_000)) {
      warn(`${prefix} Failed to ensure workflow labels: ${labelOutcome.error instanceof Error ? labelOutcome.error.message : String(labelOutcome.error)}`);
    }
    return {
      ok: false,
      processedPrs: 0,
      updatedIssues: 0,
      pendingAdded: 0,
      pendingResolved: 0,
      localClears: 0,
      error: "label-ensure-failed",
    };
  }

  const normalizedBotBranch = normalizeGitRef(params.repo.botBranch);
  if (!normalizedBotBranch) {
    warn(`${prefix} Missing bot branch; skipping in-bot reconciliation`);
    return {
      ok: false,
      processedPrs: 0,
      updatedIssues: 0,
      pendingAdded: 0,
      pendingResolved: 0,
      localClears: 0,
      error: "missing-bot-branch",
    };
  }

  const cursor = getRepoGithubInBotReconcileCursor(repo);
  if (!cursor) {
    const initAt = now().toISOString();
    recordRepoGithubInBotReconcileCursor({
      repo,
      repoPath: params.repo.path,
      botBranch: normalizedBotBranch,
      lastMergedAt: initAt,
      lastPrNumber: 0,
      updatedAt: initAt,
    });
    log(`${prefix} Initialized cursor at ${initAt}`);
    return {
      ok: true,
      processedPrs: 0,
      updatedIssues: 0,
      pendingAdded: 0,
      pendingResolved: 0,
      localClears: 0,
      initializedCursor: true,
    };
  }

  const normalizedCursorBranch = normalizeGitRef(cursor.botBranch);
  if (normalizedCursorBranch !== normalizedBotBranch) {
    const resetAt = now().toISOString();
    recordRepoGithubInBotReconcileCursor({
      repo,
      repoPath: params.repo.path,
      botBranch: normalizedBotBranch,
      lastMergedAt: resetAt,
      lastPrNumber: 0,
      updatedAt: resetAt,
    });
    clearRepoGithubInBotPendingIssues(repo);
    warn(`${prefix} Bot branch changed (${normalizedCursorBranch} -> ${normalizedBotBranch}); reset cursor and cleared pending entries.`);
    return {
      ok: true,
      processedPrs: 0,
      updatedIssues: 0,
      pendingAdded: 0,
      pendingResolved: 0,
      localClears: 0,
      resetCursor: true,
    };
  }

  let pendingResolved = 0;
  let localClears = 0;
  const pendingRows = listRepoGithubInBotPendingIssues(repo, maxPending);
  for (const pending of pendingRows) {
    const replay = await reconcilePendingIssue({ github: params.github, repo: params.repo, pending, log, warn });
    if (replay.resolved) pendingResolved += 1;
    if (replay.localCleared) localClears += 1;
  }

  let mergedPrs: MergedPullRequest[] = [];
  try {
    mergedPrs = await fetchMergedPullRequests({
      github: params.github,
      repo,
      botBranch: normalizedBotBranch,
      since: cursor.lastMergedAt,
    });
  } catch (error: any) {
    warn(`${prefix} Failed to list merged PRs: ${error?.message ?? String(error)}`);
    return {
      ok: false,
      processedPrs: 0,
      updatedIssues: 0,
      pendingAdded: 0,
      pendingResolved,
      localClears,
      error: "list-prs",
    };
  }

  const unprocessed = selectUnprocessedMergedPrs(mergedPrs, cursor);
  if (unprocessed.length === 0) {
    return {
      ok: true,
      processedPrs: 0,
      updatedIssues: 0,
      pendingAdded: 0,
      pendingResolved,
      localClears,
    };
  }

  const toProcess = unprocessed.slice(0, maxPrs);
  let processed = 0;
  let updatedIssues = 0;
  let pendingAdded = 0;
  let lastProcessed: MergedPullRequest | null = null;

  for (const pr of toProcess) {
    const issues = pr.closingIssues.filter((issue) => {
      if (issue.state.toUpperCase() !== "OPEN") return false;
      const issueRepo = parseRepoFromIssueUrl(issue.url);
      if (issueRepo !== repo) return false;
      if (!hasRalphLabel(issue.labels)) return false;
      if (hasTerminalStatus(issue.labels)) return false;
      return true;
    });

    for (const issue of issues) {
      const cleared = clearTaskExecutionStateForIssue({
        repo,
        issueNumber: issue.number,
        status: "done",
        reason: `in-bot-reconciler:pr#${pr.number}`,
      });
      if (cleared.updated) localClears += 1;
      if (cleared.hadActiveOwner) {
        warn(`${prefix} Merge evidence for #${issue.number} while active owner present; cleared local task state.`);
      }

      const ops = planIssueLabelOps({ add: [IN_BOT_LABEL], remove: TRANSITION_LABELS });
      const result = await executeIssueLabelOps({
        github: params.github,
        repo,
        issueNumber: issue.number,
        ops,
        log: (message) => log(`${prefix} ${message}`),
        logLabel: `${repo}#${issue.number}`,
      });
      if (!result.ok) {
        pendingAdded += 1;
        upsertRepoGithubInBotPendingIssue({
          repo,
          repoPath: params.repo.path,
          botBranch: params.repo.botBranch,
          issueNumber: issue.number,
          prNumber: pr.number,
          prUrl: pr.url,
          mergedAt: pr.mergedAt,
          attemptError: `label-update:${result.kind}`,
        });
        warn(`${prefix} Failed to update labels for #${issue.number}; queued pending retry.`);
        continue;
      }

      deleteRepoGithubInBotPendingIssue({ repo, issueNumber: issue.number, prNumber: pr.number });
      updatedIssues += 1;
    }

    processed += 1;
    lastProcessed = pr;
  }

  if (lastProcessed) {
    recordRepoGithubInBotReconcileCursor({
      repo,
      repoPath: params.repo.path,
      botBranch: normalizedBotBranch,
      lastMergedAt: lastProcessed.mergedAt,
      lastPrNumber: lastProcessed.number,
    });
  }

  log(
    `${prefix} processed=${processed} updatedIssues=${updatedIssues} pendingAdded=${pendingAdded} pendingResolved=${pendingResolved} localClears=${localClears}`
  );
  return {
    ok: true,
    processedPrs: processed,
    updatedIssues,
    pendingAdded,
    pendingResolved,
    localClears,
  };
}

function startRepoInBotReconciler(params: {
  repo: RepoConfig;
  baseIntervalMs: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  ensureLabels?: EnsureLabels;
}): PollerHandle {
  let stopped = false;
  let timer: TimeoutHandle | null = null;
  let inFlight = false;
  let delayMs = params.baseIntervalMs;

  const scheduleNext = (nextDelay: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, applyJitter(nextDelay));
  };

  const tick = async () => {
    if (stopped) return;
    if (inFlight) {
      scheduleNext(delayMs);
      return;
    }
    inFlight = true;

    const github = new GitHubClient(params.repo.name);
    let hadError = false;
    try {
      const result = await reconcileRepoInBotState({
        repo: params.repo,
        github,
        log: params.log,
        warn: params.warn,
        ensureLabels: params.ensureLabels,
      });
      hadError = !result.ok;
      const hadWork =
        result.ok &&
        (result.processedPrs > 0 || result.updatedIssues > 0 || result.pendingAdded > 0 || result.pendingResolved > 0 || result.localClears > 0);
      const resolved = resolveDelay({
        baseMs: params.baseIntervalMs,
        previousMs: delayMs,
        hadError,
        hadWork,
      });
      delayMs = resolved.delayMs;
      if (resolved.reason === "idle" && shouldLog(`ralph:in-bot:${params.repo.name}:idle`, IDLE_LOG_INTERVAL_MS)) {
        const seconds = Math.round(delayMs / 1000);
        const details = result.initializedCursor
          ? "initialized cursor"
          : result.resetCursor
            ? "reset cursor"
            : "no new bot-branch merges";
        (params.log ?? ((message: string) => console.log(message)))(
          `[ralph:in-bot:${params.repo.name}] idle (${details}); next check in ${seconds}s`
        );
      }
    } catch (error: any) {
      hadError = true;
      const warn = params.warn ?? ((message: string) => console.warn(message));
      warn(`[ralph:in-bot:${params.repo.name}] Unexpected error: ${error?.message ?? String(error)}`);
      delayMs = nextDelayMs({ baseMs: params.baseIntervalMs, previousMs: delayMs, hadError });
    } finally {
      inFlight = false;
      if (!stopped) {
        scheduleNext(delayMs);
      }
    }
  };

  scheduleNext(delayMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function startGitHubInBotReconciler(params: {
  repos: RepoConfig[];
  baseIntervalMs: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): PollerHandle {
  const log = params.log ?? ((message: string) => console.log(message));
  const warn = params.warn ?? ((message: string) => console.warn(message));
  const handles: PollerHandle[] = [];
  const labelsEnsurer = createRalphWorkflowLabelsEnsurer({
    githubFactory: (repo) => new GitHubClient(repo),
    log,
    warn,
  });

  for (const repo of params.repos) {
    if (!repo.name || !repo.path || !repo.botBranch) {
      log(`[ralph:in-bot] Skipping repo with missing config: ${JSON.stringify(repo.name)}`);
      continue;
    }
    handles.push(
      startRepoInBotReconciler({
        repo,
        baseIntervalMs: params.baseIntervalMs,
        log,
        warn,
        ensureLabels: labelsEnsurer.ensure,
      })
    );
  }

  if (handles.length === 0) {
    log("[ralph:in-bot] No repos configured for in-bot reconciliation.");
  } else {
    log(`[ralph:in-bot] Started in-bot reconciliation for ${handles.length} repo(s).`);
  }

  return {
    stop: () => {
      for (const handle of handles) handle.stop();
      handles.length = 0;
    },
  };
}
