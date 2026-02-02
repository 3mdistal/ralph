import { resolveAgentTaskByIssue, updateTaskStatus } from "../queue-backend";
import {
  getEscalationCommentCheckState,
  getIssueSnapshotByNumber,
  hasIdempotencyKey,
  initStateDb,
  listIssuesWithAllLabels,
  recordEscalationCommentCheckState,
  recordIdempotencyKey,
} from "../state";
import { GitHubClient, splitRepoFullName } from "./client";
import { shouldLog } from "../logging";
import { ensureRalphWorkflowLabelsOnce } from "./ensure-ralph-workflow-labels";
import { executeIssueLabelOps, type LabelOp } from "./issue-label-io";
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
  getIssueSnapshotByNumber: typeof getIssueSnapshotByNumber;
  getEscalationCommentCheckState: typeof getEscalationCommentCheckState;
  recordEscalationCommentCheckState: typeof recordEscalationCommentCheckState;
};

const DEFAULT_MAX_ESCALATIONS = 10;
const DEFAULT_MAX_RECENT_COMMENTS = 20;
const DEFAULT_ESCALATION_RECHECK_INTERVAL_MS = 10 * 60_000;
const ESCALATION_DEFER_LOG_INTERVAL_MS = 60_000;
const AUTHORIZED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const RALPH_APPROVE_REGEX = /\bRALPH\s+APPROVE\b/i;
const RALPH_OVERRIDE_REGEX = /\bRALPH\s+OVERRIDE\s*:\s*([\s\S]*)/i;
const CONSULTANT_JSON_BLOCK_REGEX = /```json\s*([\s\S]*?)```/i;
const CONSULTANT_MARKER_REGEX = /<!--\s*ralph-consultant:v\d+\s*-->/i;

type IssueCommentNode = {
  body?: string | null;
  author?: { login?: string | null } | null;
  authorAssociation?: string | null;
  databaseId?: number | null;
  createdAt?: string | null;
};

type IssueCommentsResponse = {
  data?: { repository?: { issue?: { comments?: { nodes?: IssueCommentNode[] } } } };
};

type ConsultantDecision = {
  schema_version?: number;
  decision?: string;
  confidence?: string;
  requires_approval?: boolean;
  proposed_resolution_text?: string;
  reason?: string;
};

function issueKey(issue: EscalatedIssue): string {
  return `${issue.repo}#${issue.number}`;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAuthorizedComment(params: { repoOwner: string; authorLogin: string | null; authorAssociation: string | null }): boolean {
  const author = params.authorLogin?.toLowerCase() ?? "";
  const association = params.authorAssociation?.toUpperCase() ?? "";
  return (params.repoOwner && author === params.repoOwner) || AUTHORIZED_ASSOCIATIONS.has(association);
}

function extractOverrideText(body: string): string | null {
  const match = body.match(RALPH_OVERRIDE_REGEX);
  const raw = match?.[1] ?? "";
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function parseConsultantDecisionFromBody(body: string): ConsultantDecision | null {
  const marker = body.match(CONSULTANT_MARKER_REGEX);
  if (!marker) return null;
  const afterMarker = body.slice((marker.index ?? 0) + marker[0].length);
  const match = afterMarker.match(CONSULTANT_JSON_BLOCK_REGEX);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    return {
      schema_version: typeof obj.schema_version === "number" ? obj.schema_version : undefined,
      decision: typeof obj.decision === "string" ? obj.decision : undefined,
      confidence: typeof obj.confidence === "string" ? obj.confidence : undefined,
      requires_approval: typeof obj.requires_approval === "boolean" ? obj.requires_approval : undefined,
      proposed_resolution_text: typeof obj.proposed_resolution_text === "string" ? obj.proposed_resolution_text : undefined,
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
    };
  } catch {
    return null;
  }
}

function findLatestConsultantDecision(comments: IssueCommentNode[]): ConsultantDecision | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body ?? "";
    const parsed = parseConsultantDecisionFromBody(body);
    if (parsed) return parsed;
  }
  return null;
}

function findLatestApprovalCommand(params: {
  repoOwner: string;
  comments: IssueCommentNode[];
}):
  | { kind: "approve"; databaseId: number | null; createdAt: string | null }
  | { kind: "override"; databaseId: number | null; createdAt: string | null; overrideText: string }
  | null
{
  for (let i = params.comments.length - 1; i >= 0; i -= 1) {
    const entry = params.comments[i];
    const body = entry?.body ?? "";
    if (!body) continue;
    if (body.includes(RALPH_ESCALATION_MARKER_PREFIX)) continue;
    if (!isAuthorizedComment({
      repoOwner: params.repoOwner,
      authorLogin: entry?.author?.login ?? null,
      authorAssociation: entry?.authorAssociation ?? null,
    })) {
      continue;
    }

    if (RALPH_APPROVE_REGEX.test(body)) {
      return { kind: "approve", databaseId: typeof entry?.databaseId === "number" ? entry.databaseId : null, createdAt: entry?.createdAt ?? null };
    }

    const overrideText = extractOverrideText(body);
    if (overrideText) {
      return {
        kind: "override",
        databaseId: typeof entry?.databaseId === "number" ? entry.databaseId : null,
        createdAt: entry?.createdAt ?? null,
        overrideText,
      };
    }
  }
  return null;
}

async function createIssueComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<{ id: number | null; createdAt: string | null; url: string | null }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<{ id?: number | null; created_at?: string | null; html_url?: string | null }>(
    `/repos/${owner}/${name}/issues/${params.issueNumber}/comments`,
    {
      method: "POST",
      body: { body: params.body },
    }
  );
  const id = typeof response.data?.id === "number" ? response.data.id : null;
  const createdAt = response.data?.created_at ?? null;
  const url = response.data?.html_url ?? null;
  return { id, createdAt, url };
}

function shouldFetchEscalationComments(params: {
  nowMs: number;
  lastCheckedAt: string | null;
  lastSeenUpdatedAt: string | null;
  githubUpdatedAt: string | null;
  minIntervalMs: number;
}): { shouldFetch: boolean; reason: "initial" | "updated" | "interval" | "defer" } {
  const lastCheckedMs = parseIsoMs(params.lastCheckedAt);
  const lastSeenUpdatedMs = parseIsoMs(params.lastSeenUpdatedAt);
  const currentUpdatedMs = parseIsoMs(params.githubUpdatedAt);

  if (lastCheckedMs === null) return { shouldFetch: true, reason: "initial" };
  if (currentUpdatedMs !== null && (lastSeenUpdatedMs === null || currentUpdatedMs > lastSeenUpdatedMs)) {
    return { shouldFetch: true, reason: "updated" };
  }
  if (params.nowMs - lastCheckedMs >= params.minIntervalMs) {
    return { shouldFetch: true, reason: "interval" };
  }
  return { shouldFetch: false, reason: "defer" };
}

export function __shouldFetchEscalationCommentsForTests(
  params: Parameters<typeof shouldFetchEscalationComments>[0]
): ReturnType<typeof shouldFetchEscalationComments> {
  return shouldFetchEscalationComments(params);
}

async function listRecentIssueComments(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  limit: number;
}): Promise<
  Array<{
    body: string;
    authorLogin: string | null;
    authorAssociation: string | null;
    databaseId: number | null;
    createdAt: string | null;
  }>
> {
  const { owner, name } = splitRepoFullName(params.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!, $last: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: $last) {
        nodes {
          body
          databaseId
          createdAt
          author {
            login
          }
          authorAssociation
        }
      }
    }
  }
}`;

  const response = await params.github.request<IssueCommentsResponse>("/graphql", {
    method: "POST",
    body: {
      query,
      variables: { owner, name, number: params.issueNumber, last: params.limit },
    },
  });

  const nodes = response.data?.data?.repository?.issue?.comments?.nodes ?? [];
  return nodes.map((node) => ({
    body: node?.body ?? "",
    authorLogin: node?.author?.login ?? null,
    authorAssociation: node?.authorAssociation ?? null,
    databaseId: typeof node?.databaseId === "number" ? node.databaseId : null,
    createdAt: node?.createdAt ?? null,
  }));
}

function buildResolutionLabelOps(params: { ensureQueued: boolean }): LabelOp[] {
  const ops: LabelOp[] = [];
  if (params.ensureQueued) {
    ops.push({ action: "add", label: RALPH_LABEL_QUEUED });
  }
  ops.push({ action: "remove", label: RALPH_LABEL_ESCALATED });
  return ops;
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

  const labelOps = buildResolutionLabelOps({ ensureQueued: params.ensureQueued });
  const labelResult = await executeIssueLabelOps({
    github: params.deps.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    ops: labelOps,
    log: (message) => params.log(`${prefix} ${message}`),
    logLabel: `${params.repo}#${params.issueNumber}`,
    ensureLabels: async () => await ensureRalphWorkflowLabelsOnce({ repo: params.repo, github: params.deps.github }),
    retryMissingLabelOnce: true,
    ensureBefore: true,
  });
  if (!labelResult.ok) {
    params.log(`${prefix} Failed to update escalation labels for #${params.issueNumber}.`);
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
  minRecheckIntervalMs?: number;
  now?: () => Date;
}): Promise<void> {
  const log = params.log ?? console.log;
  const maxEscalations = params.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  const maxRecentComments = params.maxRecentComments ?? DEFAULT_MAX_RECENT_COMMENTS;
  const minRecheckIntervalMs = params.minRecheckIntervalMs ?? DEFAULT_ESCALATION_RECHECK_INTERVAL_MS;
  const now = params.now ?? (() => new Date());
  const nowMs = now().getTime();
  const nowIso = new Date(nowMs).toISOString();
  const repoOwner = params.repo.split("/")[0]?.toLowerCase() ?? "";
  if (!params.deps) {
    initStateDb();
  }
  const deps =
    params.deps ??
    ({
      github: new GitHubClient(params.repo),
      listIssuesWithAllLabels,
      resolveAgentTaskByIssue,
      updateTaskStatus,
      getIssueSnapshotByNumber,
      getEscalationCommentCheckState,
      recordEscalationCommentCheckState,
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
    const snapshot = deps.getIssueSnapshotByNumber(params.repo, issue.number);
    const githubUpdatedAt = snapshot?.githubUpdatedAt ?? null;
    const checkState = deps.getEscalationCommentCheckState(params.repo, issue.number) ?? {
      lastCheckedAt: null,
      lastSeenUpdatedAt: null,
      lastResolvedCommentId: null,
      lastResolvedCommentAt: null,
    };
    const decision = shouldFetchEscalationComments({
      nowMs,
      lastCheckedAt: checkState.lastCheckedAt,
      lastSeenUpdatedAt: checkState.lastSeenUpdatedAt,
      githubUpdatedAt,
      minIntervalMs: minRecheckIntervalMs,
    });
    if (!decision.shouldFetch) {
      if (shouldLog(`ralph:gh-escalation:${params.repo}:defer:${issue.number}`, ESCALATION_DEFER_LOG_INTERVAL_MS)) {
        const lastCheckedMs = parseIsoMs(checkState.lastCheckedAt) ?? nowMs;
        const remainingMs = minRecheckIntervalMs - (nowMs - lastCheckedMs);
        const remaining = remainingMs > 0 ? ` next_in=${Math.round(remainingMs / 1000)}s` : "";
        log(
          `[ralph:gh-escalation:${params.repo}] deferring comment check for #${issue.number} ` +
            `(reason=${decision.reason}${remaining})`
        );
      }
      continue;
    }
    let bodies: Array<{
      body: string;
      authorLogin: string | null;
      authorAssociation: string | null;
      databaseId: number | null;
      createdAt: string | null;
    }> = [];
    try {
      bodies = await listRecentIssueComments({
        github: deps.github,
        repo: issue.repo,
        issueNumber: issue.number,
        limit: maxRecentComments,
      });
    } catch (error: any) {
      deps.recordEscalationCommentCheckState({
        repo: params.repo,
        issueNumber: issue.number,
        lastCheckedAt: nowIso,
        lastSeenUpdatedAt: githubUpdatedAt ?? checkState.lastSeenUpdatedAt,
      });
      log(
        `[ralph:gh-escalation:${params.repo}] Failed to list comments for #${issue.number}: ${
          error?.message ?? String(error)
        }`
      );
      continue;
    }
    deps.recordEscalationCommentCheckState({
      repo: params.repo,
      issueNumber: issue.number,
      lastCheckedAt: nowIso,
      lastSeenUpdatedAt: githubUpdatedAt ?? checkState.lastSeenUpdatedAt,
    });

     // Consultant approval flow: if a consultant packet is present and the operator comments
     // `RALPH APPROVE` / `RALPH OVERRIDE: ...`, translate it into a normal resolution and requeue.
     const approval = findLatestApprovalCommand({ repoOwner, comments: bodies });
     if (approval) {
       const key = `gh-consultant-approval:${issue.repo}#${issue.number}:${approval.databaseId ?? "noid"}`;
       if (!hasIdempotencyKey(key)) {
         const consultant = findLatestConsultantDecision(bodies);
         const decision = (consultant?.decision ?? "").toLowerCase();
         const requiresApproval = consultant?.requires_approval !== false;
         const proposed = (consultant?.proposed_resolution_text ?? "").trim();

         if (requiresApproval && decision === "needs-human" && proposed) {
           const guidance = approval.kind === "override" ? approval.overrideText : proposed;
           const resolvedCommentBody = [`RALPH RESOLVED:`, guidance].join("\n");

           try {
             const created = await createIssueComment({
               github: deps.github,
               repo: issue.repo,
               issueNumber: issue.number,
               body: resolvedCommentBody,
             });

             await resolveEscalation({
               deps,
               repo: issue.repo,
               issueNumber: issue.number,
               ensureQueued: true,
               log,
               reason: approval.kind === "override" ? "RALPH OVERRIDE" : "RALPH APPROVE",
             });

             recordIdempotencyKey({
               key,
               scope: "gh-consultant-approval",
               payloadJson: JSON.stringify({ approval: approval.databaseId ?? null, resolved: created.id ?? null }),
             });

             deps.recordEscalationCommentCheckState({
               repo: params.repo,
               issueNumber: issue.number,
               lastCheckedAt: nowIso,
               lastSeenUpdatedAt: githubUpdatedAt ?? checkState.lastSeenUpdatedAt,
               lastResolvedCommentId: created.id,
               lastResolvedCommentAt: created.createdAt,
             });

             continue;
           } catch (error: any) {
             log(
               `[ralph:gh-escalation:${params.repo}] Failed to apply consultant approval for #${issue.number}: ${
                 error?.message ?? String(error)
               }`
             );
           }
         }
       }
     }
    let resolution:
      | {
          databaseId: number | null;
          createdAt: string | null;
          body: string;
        }
      | null = null;
    for (let i = bodies.length - 1; i >= 0; i -= 1) {
      const entry = bodies[i];
      const author = entry.authorLogin?.toLowerCase() ?? "";
      const association = entry.authorAssociation?.toUpperCase() ?? "";
      const isAuthorized = (repoOwner && author === repoOwner) || AUTHORIZED_ASSOCIATIONS.has(association);
      if (!isAuthorized) continue;
      if (!RALPH_RESOLVED_REGEX.test(entry.body)) continue;
      if (entry.body.includes(RALPH_ESCALATION_MARKER_PREFIX)) continue;
      resolution = { databaseId: entry.databaseId ?? null, createdAt: entry.createdAt ?? null, body: entry.body };
      break;
    }

    if (!resolution) continue;
    if (typeof resolution.databaseId === "number" && checkState.lastResolvedCommentId === resolution.databaseId) {
      continue;
    }

    try {
      await resolveEscalation({
        deps,
        repo: issue.repo,
        issueNumber: issue.number,
        ensureQueued: true,
        log,
        reason: "RALPH RESOLVED comment",
      });

      deps.recordEscalationCommentCheckState({
        repo: params.repo,
        issueNumber: issue.number,
        lastCheckedAt: nowIso,
        lastSeenUpdatedAt: githubUpdatedAt ?? checkState.lastSeenUpdatedAt,
        lastResolvedCommentId: resolution.databaseId ?? null,
        lastResolvedCommentAt: resolution.createdAt ?? null,
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
