import { resolveAgentTaskByIssue, updateTaskStatus } from "../queue-backend";
import { listIssuesWithAllLabels } from "../state";
import { GitHubClient, splitRepoFullName } from "./client";

type EscalatedIssue = { repo: string; number: number };

const DEFAULT_MAX_ESCALATIONS = 10;
const DEFAULT_MAX_COMMENT_PAGES = 3;

function issueKey(issue: EscalatedIssue): string {
  return `${issue.repo}#${issue.number}`;
}

async function listIssueComments(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  maxPages: number;
}): Promise<string[]> {
  const { owner, name } = splitRepoFullName(params.repo);
  const bodies: string[] = [];

  for (let page = 1; page <= params.maxPages; page += 1) {
    const response = await params.github.request<Array<{ body?: string | null }>>(
      `/repos/${owner}/${name}/issues/${params.issueNumber}/comments?per_page=100&page=${page}`
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    bodies.push(...rows.map((row) => row?.body ?? ""));
    if (rows.length < 100) break;
  }

  return bodies;
}

async function addIssueLabel(params: { github: GitHubClient; repo: string; issueNumber: number; label: string }) {
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/labels`, {
    method: "POST",
    body: { labels: [params.label] },
  });
}

async function removeIssueLabel(params: { github: GitHubClient; repo: string; issueNumber: number; label: string }) {
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/labels/${encodeURIComponent(params.label)}`,
    { method: "DELETE", allowNotFound: true }
  );
}

async function resolveEscalation(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  ensureQueued: boolean;
  log: (message: string) => void;
  reason: string;
}): Promise<void> {
  const prefix = `[ralph:gh-escalation:${params.repo}]`;

  if (params.ensureQueued) {
    try {
      await addIssueLabel({ github: params.github, repo: params.repo, issueNumber: params.issueNumber, label: "ralph:queued" });
    } catch (error: any) {
      params.log(
        `${prefix} Failed to add ralph:queued while resolving #${params.issueNumber}: ${error?.message ?? String(error)}`
      );
    }
  }

  try {
    await removeIssueLabel({ github: params.github, repo: params.repo, issueNumber: params.issueNumber, label: "ralph:escalated" });
  } catch (error: any) {
    params.log(
      `${prefix} Failed to remove ralph:escalated while resolving #${params.issueNumber}: ${error?.message ?? String(error)}`
    );
  }

  try {
    const issueRef = `${params.repo}#${params.issueNumber}`;
    const task = await resolveAgentTaskByIssue(issueRef, params.repo);
    if (!task) {
      params.log(`${prefix} No task found for ${issueRef} while resolving escalation.`);
      return;
    }

    if (task.status === "escalated") {
      await updateTaskStatus(task, "queued");
      params.log(`${prefix} Re-queued task for ${issueRef} (${params.reason}).`);
    }
  } catch (error: any) {
    params.log(
      `${prefix} Failed to re-queue task while resolving #${params.issueNumber}: ${error?.message ?? String(error)}`
    );
  }
}

export async function reconcileEscalationResolutions(params: {
  repo: string;
  log?: (message: string) => void;
  maxEscalations?: number;
  maxCommentPages?: number;
}): Promise<void> {
  const log = params.log ?? console.log;
  const maxEscalations = params.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  const maxCommentPages = params.maxCommentPages ?? DEFAULT_MAX_COMMENT_PAGES;
  const github = new GitHubClient(params.repo);

  const queuedEscalations = listIssuesWithAllLabels({
    repo: params.repo,
    labels: ["ralph:escalated", "ralph:queued"],
  });
  const escalatedIssues = listIssuesWithAllLabels({
    repo: params.repo,
    labels: ["ralph:escalated"],
  });

  const queuedKeys = new Set(queuedEscalations.map((issue) => issueKey(issue)));
  const pendingCommentChecks = escalatedIssues.filter((issue) => !queuedKeys.has(issueKey(issue)));

  for (const issue of queuedEscalations) {
    try {
      await resolveEscalation({
        github,
        repo: issue.repo,
        issueNumber: issue.number,
        ensureQueued: false,
        log,
        reason: "queued label re-added",
      });
    } catch (error: any) {
      log(
        `[ralph:gh-escalation:${params.repo}] Failed to reconcile queued escalation #${issue.number}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  const toCheck = pendingCommentChecks.slice(0, maxEscalations);
  for (const issue of toCheck) {
    let bodies: string[] = [];
    try {
      bodies = await listIssueComments({
        github,
        repo: issue.repo,
        issueNumber: issue.number,
        maxPages: maxCommentPages,
      });
    } catch (error: any) {
      log(
        `[ralph:gh-escalation:${params.repo}] Failed to list comments for #${issue.number}: ${
          error?.message ?? String(error)
        }`
      );
      continue;
    }
    const hasResolution = bodies.some((body) => /\bRALPH\s+RESOLVED:/i.test(body));
    if (!hasResolution) continue;

    try {
      await resolveEscalation({
        github,
        repo: issue.repo,
        issueNumber: issue.number,
        ensureQueued: true,
        log,
        reason: "RALPH RESOLVED comment",
      });
    } catch (error: any) {
      log(
        `[ralph:gh-escalation:${params.repo}] Failed to resolve escalation #${issue.number}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }
}
