import { splitRepoFullName, type GitHubClient } from "./client";
import { sanitizeEscalationReason } from "./escalation-writeback";
import {
  initStateDb,
  hasIdempotencyKey,
  recordIdempotencyKey,
  deleteIdempotencyKey,
  recordAlertDeliveryAttempt,
  getAlertDelivery,
} from "../state";
import type { AlertKind } from "../alerts/core";

export type AlertWritebackContext = {
  repo: string;
  issueNumber: number;
  taskName?: string | null;
  kind: AlertKind;
  fingerprint: string;
  alertId: number;
  summary: string;
  details?: string | null;
  count: number;
  lastSeenAt?: string | null;
};

export type AlertWritebackPlan = {
  marker: string;
  markerId: string;
  commentBody: string;
  idempotencyKey: string;
};

export type AlertWritebackResult = {
  postedComment: boolean;
  skippedComment: boolean;
  markerFound: boolean;
  commentUrl?: string | null;
};

type WritebackDeps = {
  github: GitHubClient;
  commentScanLimit?: number;
  log?: (message: string) => void;
  hasIdempotencyKey?: (key: string) => boolean;
  recordIdempotencyKey?: (input: { key: string; scope?: string; payloadJson?: string }) => boolean;
  deleteIdempotencyKey?: (key: string) => void;
  recordAlertDeliveryAttempt?: typeof recordAlertDeliveryAttempt;
  getAlertDelivery?: typeof getAlertDelivery;
};

type IssueComment = { body?: string | null };

const ALERT_MARKER_PREFIX = "<!-- ralph-alert:id=";
const ALERT_MARKER_REGEX = /<!--\s*ralph-alert:id=([a-f0-9]+)\s*-->/i;
const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const MAX_SUMMARY_CHARS = 500;
const MAX_DETAILS_CHARS = 3000;
const MAX_COMMENT_CHARS = 8000;

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function hashFNV1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildMarkerId(params: { repo: string; issueNumber: number; kind: AlertKind; fingerprint: string }): string {
  const base = [params.repo, params.issueNumber, params.kind, params.fingerprint].join("|");
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildMarker(params: { repo: string; issueNumber: number; kind: AlertKind; fingerprint: string }): string {
  const markerId = buildMarkerId(params);
  return `${ALERT_MARKER_PREFIX}${markerId} -->`;
}

export function extractExistingAlertMarker(body: string): string | null {
  const match = body.match(ALERT_MARKER_REGEX);
  return match?.[1] ?? null;
}

export function planAlertWriteback(ctx: AlertWritebackContext): AlertWritebackPlan {
  const marker = buildMarker({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    kind: ctx.kind,
    fingerprint: ctx.fingerprint,
  });
  const markerId = buildMarkerId({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    kind: ctx.kind,
    fingerprint: ctx.fingerprint,
  });

  const safeSummary = truncateText(sanitizeEscalationReason(ctx.summary), MAX_SUMMARY_CHARS);
  const safeDetails = ctx.details ? truncateText(sanitizeEscalationReason(ctx.details), MAX_DETAILS_CHARS) : "";

  const header = ctx.taskName?.trim()
    ? `Ralph recorded an error for **${ctx.taskName.trim()}**.`
    : "Ralph recorded an error for this task.";

  const lines = [
    marker,
    header,
    "",
    `Summary: ${safeSummary}`,
    `Occurrences: ${ctx.count}`,
    ctx.lastSeenAt ? `Last seen: ${ctx.lastSeenAt}` : null,
    safeDetails ? "" : null,
    safeDetails ? "Details:" : null,
    safeDetails ? "```" : null,
    safeDetails || null,
    safeDetails ? "```" : null,
    "",
    "Check `ralph status` for the latest task state.",
  ].filter(Boolean) as string[];

  const commentBody = truncateText(lines.join("\n"), MAX_COMMENT_CHARS);
  return {
    marker,
    markerId,
    commentBody,
    idempotencyKey: `gh-alert:${ctx.repo}#${ctx.issueNumber}:${markerId}`,
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

async function createIssueComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<{ html_url?: string | null }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<{ html_url?: string | null }>(
    `/repos/${owner}/${name}/issues/${params.issueNumber}/comments`,
    {
      method: "POST",
      body: { body: params.body },
    }
  );
  return response.data ?? {};
}

export async function writeAlertToGitHub(ctx: AlertWritebackContext, deps: WritebackDeps): Promise<AlertWritebackResult> {
  const overrideCount = [
    deps.hasIdempotencyKey,
    deps.recordIdempotencyKey,
    deps.deleteIdempotencyKey,
    deps.recordAlertDeliveryAttempt,
    deps.getAlertDelivery,
  ].filter(Boolean).length;
  if (overrideCount > 0 && overrideCount < 5) {
    throw new Error("writeAlertToGitHub requires all override helpers when any are provided");
  }
  if (overrideCount === 0) {
    initStateDb();
  }

  const plan = planAlertWriteback(ctx);
  const log = deps.log ?? console.log;
  const commentLimit = Math.min(Math.max(1, deps.commentScanLimit ?? DEFAULT_COMMENT_SCAN_LIMIT), 100);
  const hasKey = deps.hasIdempotencyKey ?? hasIdempotencyKey;
  const recordKey = deps.recordIdempotencyKey ?? recordIdempotencyKey;
  const deleteKey = deps.deleteIdempotencyKey ?? deleteIdempotencyKey;
  const recordDelivery = deps.recordAlertDeliveryAttempt ?? recordAlertDeliveryAttempt;
  const readDelivery = deps.getAlertDelivery ?? getAlertDelivery;
  const prefix = `[ralph:gh-alert:${ctx.repo}]`;

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

  const markerId = plan.markerId.toLowerCase();
  const markerFound =
    listResult?.comments.some((comment) => {
      const body = comment.body ?? "";
      const found = extractExistingAlertMarker(body);
      return found ? found.toLowerCase() === markerId : body.includes(plan.marker);
    }) ?? false;

  if (hasKeyResult && markerFound) {
    recordDelivery({
      alertId: ctx.alertId,
      channel: "github-issue-comment",
      markerId: plan.markerId,
      targetType: "issue",
      targetNumber: ctx.issueNumber,
      status: "skipped",
    });
    log(`${prefix} Alert comment already recorded (idempotency + marker); skipping.`);
    return { postedComment: false, skippedComment: true, markerFound: true, commentUrl: null };
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
      recordKey({ key: plan.idempotencyKey, scope: "gh-alert" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after marker match: ${error?.message ?? String(error)}`);
    }
    recordDelivery({
      alertId: ctx.alertId,
      channel: "github-issue-comment",
      markerId: plan.markerId,
      targetType: "issue",
      targetNumber: ctx.issueNumber,
      status: "skipped",
    });
    log(`${prefix} Existing alert marker found for #${ctx.issueNumber}; skipping comment.`);
    return { postedComment: false, skippedComment: true, markerFound: true, commentUrl: null };
  }

  let claimed = false;
  try {
    claimed = recordKey({ key: plan.idempotencyKey, scope: "gh-alert" });
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
      recordDelivery({
        alertId: ctx.alertId,
        channel: "github-issue-comment",
        markerId: plan.markerId,
        targetType: "issue",
        targetNumber: ctx.issueNumber,
        status: "skipped",
      });
      log(`${prefix} Alert comment already claimed; skipping comment.`);
      return { postedComment: false, skippedComment: true, markerFound: false, commentUrl: null };
    }
  }

  let commentUrl: string | null = null;
  try {
    const comment = await createIssueComment({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      body: plan.commentBody,
    });
    commentUrl = comment?.html_url ?? null;
  } catch (error: any) {
    if (claimed) {
      try {
        deleteKey(plan.idempotencyKey);
      } catch (deleteError: any) {
        log(`${prefix} Failed to release idempotency key: ${deleteError?.message ?? String(deleteError)}`);
      }
    }
    recordDelivery({
      alertId: ctx.alertId,
      channel: "github-issue-comment",
      markerId: plan.markerId,
      targetType: "issue",
      targetNumber: ctx.issueNumber,
      status: "failed",
      error: error?.message ?? String(error),
    });
    throw error;
  }

  if (!claimed) {
    try {
      recordKey({ key: plan.idempotencyKey, scope: "gh-alert" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after posting comment: ${error?.message ?? String(error)}`);
    }
  }

  const priorDelivery = readDelivery({ alertId: ctx.alertId, channel: "github-issue-comment", markerId: plan.markerId });
  recordDelivery({
    alertId: ctx.alertId,
    channel: "github-issue-comment",
    markerId: plan.markerId,
    targetType: "issue",
    targetNumber: ctx.issueNumber,
    status: "success",
    commentUrl: commentUrl ?? priorDelivery?.commentUrl ?? null,
  });

  log(`${prefix} Posted alert comment for #${ctx.issueNumber}.`);
  return { postedComment: true, skippedComment: false, markerFound: false, commentUrl };
}
