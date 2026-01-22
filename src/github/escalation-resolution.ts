import { resolveAgentTaskByIssue, updateTaskStatus } from "../queue-backend";
import { initStateDb, listIssuesWithAllLabels } from "../state";
import { GitHubClient, splitRepoFullName } from "./client";
import {
  RALPH_ESCALATION_MARKER_PREFIX,
  RALPH_LABEL_ESCALATED,
  RALPH_LABEL_QUEUED,
  RALPH_RESOLVED_REGEX,
} from "./escalation-constants";

type EscalatedIssue = { repo: string; number: number };

export type EscalationResolutionDeps = {
  github: GitHubClient;
  listIssuesWithAllLabels: typeof listIssuesWithAllLabels;
  resolveAgentTaskByIssue: typeof resolveAgentTaskByIssue;
  updateTaskStatus: typeof updateTaskStatus;
};

const DEFAULT_MAX_ESCALATIONS = 10;
const DEFAULT_MAX_RECENT_COMMENTS = 20;

function issueKey(issue: EscalatedIssue): string {
  return `${issue.repo}#${issue.number}`;
}

async function listRecentIssueComments(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  limit: number;
}): Promise<string[]> {
  const { owner, name } = splitRepoFullName(params.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!, $last: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: $last) {
        nodes {
          body
        }
      }
    }
  }
}`;

  const response = await params.github.request<{
    data?: { repository?: { issue?: { comments?: { nodes?: Array<{ body?: string | null }> } } } };
  }>("/graphql", {
    method: "POST",
    body: {
      query,
      variables: { owner, name, number: params.issueNumber, last: params.limit },
    },
  });

  const nodes = response.data?.data?.repository?.issue?.comments?.nodes ?? [];
  return nodes.map((node: { body?: string | null } | undefined) => node?.body ?? "");
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
  deps: EscalationResolutionDeps;
  repo: string;
  issueNumber: number;
  ensureQueued: boolean;
  log: (message: string) => void;
  reason: string;
}): Promise<void> {
  const prefix = `[ralph:gh-escalation:${params.repo}]`;

  if (params.ensureQueued) {
    try {
      await addIssueLabel({
        github: params.deps.github,
        repo: params.repo,
        issueNumber: params.issueNumber,
        label: RALPH_LABEL_QUEUED,
      });
    } catch (error: any) {
      params.log(
        `${prefix} Failed to add ralph:queued while resolving #${params.issueNumber}: ${error?.message ?? String(error)}`
      );
    }
  }

  try {
    await removeIssueLabel({
      github: params.deps.github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      label: RALPH_LABEL_ESCALATED,
    });
  } catch (error: any) {
    params.log(
      `${prefix} Failed to remove ralph:escalated while resolving #${params.issueNumber}: ${error?.message ?? String(error)}`
    );
  }

  try {
    const issueRef = `${params.repo}#${params.issueNumber}`;
    const task = await params.deps.resolveAgentTaskByIssue(issueRef, params.repo);
    if (!task) {
      params.log(`${prefix} No task found for ${issueRef} while resolving escalation.`);
      return;
    }

    if (task.status === "escalated") {
      await params.deps.updateTaskStatus(task, "queued");
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
  maxRecentComments?: number;
  deps?: EscalationResolutionDeps;
}): Promise<void> {
  const log = params.log ?? console.log;
  const maxEscalations = params.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  const maxRecentComments = params.maxRecentComments ?? DEFAULT_MAX_RECENT_COMMENTS;
  initStateDb();
  const deps =
    params.deps ??
    ({
      github: new GitHubClient(params.repo),
      listIssuesWithAllLabels,
      resolveAgentTaskByIssue,
      updateTaskStatus,
    } satisfies EscalationResolutionDeps);

  const queuedEscalations = deps.listIssuesWithAllLabels({
    repo: params.repo,
    labels: [RALPH_LABEL_ESCALATED, RALPH_LABEL_QUEUED],
  });
  const escalatedIssues = deps.listIssuesWithAllLabels({
    repo: params.repo,
    labels: [RALPH_LABEL_ESCALATED],
  });

  const queuedKeys = new Set(queuedEscalations.map((issue) => issueKey(issue)));
  const pendingCommentChecks = escalatedIssues.filter((issue) => !queuedKeys.has(issueKey(issue)));

  for (const issue of queuedEscalations) {
    try {
      await resolveEscalation({
        deps,
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
      bodies = await listRecentIssueComments({
        github: deps.github,
        repo: issue.repo,
        issueNumber: issue.number,
        limit: maxRecentComments,
      });
    } catch (error: any) {
      log(
        `[ralph:gh-escalation:${params.repo}] Failed to list comments for #${issue.number}: ${
          error?.message ?? String(error)
        }`
      );
      continue;
    }
    const hasResolution = bodies.some(
      (body) => RALPH_RESOLVED_REGEX.test(body) && !body.includes(RALPH_ESCALATION_MARKER_PREFIX)
    );
    if (!hasResolution) continue;

    try {
      await resolveEscalation({
        deps,
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
