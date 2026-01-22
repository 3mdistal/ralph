import { deleteIdempotencyKey, hasIdempotencyKey, initStateDb, recordIdempotencyKey } from "../state";
import {
  RALPH_LABEL_ESCALATED,
  RALPH_LABEL_IN_PROGRESS,
  RALPH_LABEL_QUEUED,
  RALPH_ESCALATION_MARKER_REGEX,
  RALPH_RESOLVED_TEXT,
} from "./escalation-constants";
import { GitHubClient, splitRepoFullName } from "./client";

export type EscalationWritebackContext = {
  repo: string;
  issueNumber: number;
  taskName: string;
  taskPath: string;
  reason: string;
  escalationType: string;
  ownerHandle?: string;
};

export type EscalationWritebackPlan = {
  marker: string;
  markerId: string;
  commentBody: string;
  addLabels: string[];
  removeLabels: string[];
  idempotencyKey: string;
};

export type EscalationWritebackResult = {
  postedComment: boolean;
  skippedComment: boolean;
  markerFound: boolean;
};

type IssueComment = { body?: string | null };

type WritebackDeps = {
  github: GitHubClient;
  commentScanLimit?: number;
  log?: (message: string) => void;
  hasIdempotencyKey?: (key: string) => boolean;
  recordIdempotencyKey?: (input: { key: string; scope?: string; payloadJson?: string }) => boolean;
  deleteIdempotencyKey?: (key: string) => void;
};

const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const MAX_REASON_CHARS = 500;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildEscalationMarkerId(params: {
  repo: string;
  issueNumber: number;
  escalationType: string;
}): string {
  const base = [params.repo, params.issueNumber, params.escalationType].join("|");
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

export function buildEscalationMarker(params: {
  repo: string;
  issueNumber: number;
  escalationType: string;
}): string {
  const markerId = buildEscalationMarkerId(params);
  return `<!-- ralph-escalation:id=${markerId} -->`;
}

export function extractExistingMarker(body: string): string | null {
  const match = body.match(RALPH_ESCALATION_MARKER_REGEX);
  return match?.[1] ?? null;
}

export function buildEscalationComment(params: {
  marker: string;
  taskName: string;
  issueUrl: string;
  reason: string;
  ownerHandle: string;
}): string {
  const owner = params.ownerHandle.trim();
  const mention = owner ? `${owner} ` : "";
  const reason = truncateText(params.reason, MAX_REASON_CHARS) || "(no reason provided)";

  return [
    params.marker,
    `${mention}Ralph needs a decision to proceed on **${params.taskName}**.`,
    "",
    `Issue: ${params.issueUrl}`,
    "",
    "Reason:",
    reason,
    "",
    "To resolve:",
    `1. Comment with \`${RALPH_RESOLVED_TEXT} <guidance>\` to resume with guidance.`,
    `2. Or re-add the \`${RALPH_LABEL_QUEUED}\` label to resume without extra guidance. Ralph will remove \`${
      RALPH_LABEL_ESCALATED
    }\`.`,
  ].join("\n");
}

export function planEscalationWriteback(ctx: EscalationWritebackContext): EscalationWritebackPlan {
  const repoOwner = ctx.repo.split("/")[0] ?? "";
  const ownerHandle = ctx.ownerHandle?.trim() || (repoOwner ? `@${repoOwner}` : "");
  const marker = buildEscalationMarker({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    escalationType: ctx.escalationType,
  });

  const issueUrl = `https://github.com/${ctx.repo}/issues/${ctx.issueNumber}`;
  const commentBody = buildEscalationComment({
    marker,
    taskName: ctx.taskName,
    issueUrl,
    reason: ctx.reason,
    ownerHandle,
  });

  const markerId = buildEscalationMarkerId({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    escalationType: ctx.escalationType,
  });
  const idempotencyKey = `gh-escalation:${ctx.repo}#${ctx.issueNumber}:${markerId}`;

  return {
    marker,
    markerId,
    commentBody,
    addLabels: [RALPH_LABEL_ESCALATED],
    removeLabels: [RALPH_LABEL_IN_PROGRESS, RALPH_LABEL_QUEUED],
    idempotencyKey,
  };
}

async function listRecentIssueComments(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  limit: number;
}): Promise<{ comments: IssueComment[]; reachedMax: boolean }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!, $last: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: $last) {
        nodes {
          body
        }
        pageInfo {
          hasPreviousPage
        }
      }
    }
  }
}`;

  const response = await params.github.request<{
    data?: {
      repository?: {
        issue?: { comments?: { nodes?: Array<{ body?: string | null }>; pageInfo?: { hasPreviousPage?: boolean } } };
      };
    };
  }>("/graphql", {
    method: "POST",
    body: {
      query,
      variables: { owner, name, number: params.issueNumber, last: params.limit },
    },
  });

  const nodes = response.data?.data?.repository?.issue?.comments?.nodes ?? [];
  const comments = nodes.map((node) => ({ body: node?.body ?? "" }));
  const reachedMax = Boolean(response.data?.data?.repository?.issue?.comments?.pageInfo?.hasPreviousPage);

  return { comments, reachedMax };
}

async function createIssueComment(params: { github: GitHubClient; repo: string; issueNumber: number; body: string }) {
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/comments`, {
    method: "POST",
    body: { body: params.body },
  });
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

export async function writeEscalationToGitHub(
  ctx: EscalationWritebackContext,
  deps: WritebackDeps
): Promise<EscalationWritebackResult> {
  const overrideCount = [deps.hasIdempotencyKey, deps.recordIdempotencyKey, deps.deleteIdempotencyKey].filter(
    Boolean
  ).length;
  if (overrideCount > 0 && overrideCount < 3) {
    throw new Error("writeEscalationToGitHub requires all idempotency overrides when any are provided");
  }
  if (overrideCount === 0) {
    initStateDb();
  }
  const plan = planEscalationWriteback(ctx);
  const log = deps.log ?? console.log;
  const commentLimit = Math.min(Math.max(1, deps.commentScanLimit ?? DEFAULT_COMMENT_SCAN_LIMIT), 100);
  const hasKey = deps.hasIdempotencyKey ?? hasIdempotencyKey;
  const recordKey = deps.recordIdempotencyKey ?? recordIdempotencyKey;
  const deleteKey = deps.deleteIdempotencyKey ?? deleteIdempotencyKey;
  const prefix = `[ralph:gh-escalation:${ctx.repo}]`;

  for (const label of plan.removeLabels) {
    try {
      await removeIssueLabel({ github: deps.github, repo: ctx.repo, issueNumber: ctx.issueNumber, label });
    } catch (error: any) {
      log(`${prefix} Failed to remove label '${label}' on #${ctx.issueNumber}: ${error?.message ?? String(error)}`);
    }
  }

  for (const label of plan.addLabels) {
    try {
      await addIssueLabel({ github: deps.github, repo: ctx.repo, issueNumber: ctx.issueNumber, label });
    } catch (error: any) {
      log(`${prefix} Failed to add label '${label}' on #${ctx.issueNumber}: ${error?.message ?? String(error)}`);
    }
  }

  let hasKeyResult = false;
  let ignoreExistingKey = false;
  try {
    hasKeyResult = hasKey(plan.idempotencyKey);
  } catch (error: any) {
    log(`${prefix} Failed to check idempotency: ${error?.message ?? String(error)}`);
  }

  let listResult: { comments: IssueComment[]; reachedMax: boolean } | null = null;
  try {
    listResult = await listRecentIssueComments({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      limit: commentLimit,
    });
  } catch (error: any) {
    log(`${prefix} Failed to list issue comments: ${error?.message ?? String(error)}`);
  }

  if (listResult?.reachedMax) {
    log(`${prefix} Comment scan hit cap (${commentLimit}); marker detection may be incomplete.`);
  }

  const markerFound =
    listResult?.comments.some((comment) => {
      const body = comment.body ?? "";
      const found = extractExistingMarker(body);
      return found ? found === plan.markerId : body.includes(plan.marker);
    }) ?? false;

  if (hasKeyResult && markerFound) {
    log(`${prefix} Escalation comment already recorded (idempotency + marker); skipping.`);
    return { postedComment: false, skippedComment: true, markerFound: true };
  }

  const scanComplete = Boolean(listResult && !listResult.reachedMax);

  if (hasKeyResult && scanComplete && !markerFound) {
    ignoreExistingKey = true;
    try {
      deleteKey(plan.idempotencyKey);
    } catch (error: any) {
      log(`${prefix} Failed to clear stale idempotency key: ${error?.message ?? String(error)}`);
    }
  }

  if (hasKeyResult && !scanComplete && !markerFound) {
    ignoreExistingKey = true;
    log(`${prefix} Idempotency key exists but marker scan incomplete; proceeding cautiously.`);
  }

  if (markerFound) {
    try {
      recordKey({ key: plan.idempotencyKey, scope: "gh-escalation" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after marker match: ${error?.message ?? String(error)}`);
    }
    log(`${prefix} Existing escalation marker found for #${ctx.issueNumber}; skipping comment.`);
    return { postedComment: false, skippedComment: true, markerFound: true };
  }


  let claimed = false;
  try {
    claimed = recordKey({ key: plan.idempotencyKey, scope: "gh-escalation" });
  } catch (error: any) {
    log(`${prefix} Failed to record idempotency before posting comment: ${error?.message ?? String(error)}`);
  }

  if (!claimed && !ignoreExistingKey) {
    let alreadyClaimed = false;
    try {
      alreadyClaimed = hasKey(plan.idempotencyKey);
    } catch (error: any) {
      log(`${prefix} Failed to re-check idempotency: ${error?.message ?? String(error)}`);
    }
    if (alreadyClaimed) {
      log(`${prefix} Escalation comment already claimed; skipping comment.`);
      return { postedComment: false, skippedComment: true, markerFound: false };
    }
  }


  try {
    await createIssueComment({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      body: plan.commentBody,
    });
  } catch (error) {
    if (claimed) {
      try {
        deleteKey(plan.idempotencyKey);
      } catch (deleteError: any) {
        log(`${prefix} Failed to release idempotency key: ${deleteError?.message ?? String(deleteError)}`);
      }
    }
    throw error;
  }

  if (!claimed) {
    try {
      recordKey({ key: plan.idempotencyKey, scope: "gh-escalation" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after posting comment: ${error?.message ?? String(error)}`);
    }
  }

  log(`${prefix} Posted escalation comment for #${ctx.issueNumber}.`);

  return { postedComment: true, skippedComment: false, markerFound: false };
}
