import { RALPH_LABEL_STUCK } from "../github-labels";
import { redactHomePathForDisplay } from "../redaction";
import { deleteIdempotencyKey, getIdempotencyPayload, hasIdempotencyKey, initStateDb, recordIdempotencyKey } from "../state";
import type { WatchdogTimeoutInfo } from "../session";
import { sanitizeEscalationReason } from "./escalation-writeback";
import { GitHubClient, splitRepoFullName } from "./client";
import { addIssueLabel } from "./issue-label-io";

export type WatchdogStuckWritebackContext = {
  repo: string;
  issueNumber: number;
  taskName: string;
  taskPath: string;
  stage: string;
  retryIndex: number;
  signatureHash: string;
  sessionId?: string;
  worktreePath?: string;
  timeout?: WatchdogTimeoutInfo;
  suggestedCommands?: string[];
};

export type WatchdogStuckWritebackPlan = {
  marker: string;
  markerId: string;
  commentBody: string;
  addLabels: string[];
  removeLabels: string[];
  idempotencyKey: string;
};

export type WatchdogStuckWritebackResult = {
  postedComment: boolean;
  skippedComment: boolean;
  markerFound: boolean;
  commentUrl?: string | null;
};

type IssueComment = { body?: string | null; url?: string | null };

type WritebackDeps = {
  github: GitHubClient;
  commentScanLimit?: number;
  log?: (message: string) => void;
  hasIdempotencyKey?: (key: string) => boolean;
  recordIdempotencyKey?: (input: { key: string; scope?: string; payloadJson?: string }) => boolean;
  deleteIdempotencyKey?: (key: string) => void;
  getIdempotencyPayload?: (key: string) => string | null;
};

const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const MAX_EVENT_LINES = 20;
const MAX_EVENT_CHARS = 400;
const MAX_SNIPPET_CHARS = 800;
const MAX_REASON_CHARS = 500;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const DEFAULT_COMMANDS = ["bun test", "bun run typecheck", "bun run build"];
const MARKER_REGEX = /<!--\s*ralph-watchdog-stuck:id=([a-f0-9]+)\s*-->/i;

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

export function buildWatchdogStuckMarker(params: {
  repo: string;
  issueNumber: number;
  stage: string;
  retryIndex: number;
  signatureHash: string;
  sessionId?: string;
}): string {
  const base = [
    params.repo,
    params.issueNumber,
    params.stage,
    String(params.retryIndex),
    params.signatureHash,
    params.sessionId ?? "",
  ].join("|");
  const markerId = `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
  return `<!-- ralph-watchdog-stuck:id=${markerId} -->`;
}

export function extractExistingWatchdogMarker(body: string): string | null {
  const match = body.match(MARKER_REGEX);
  return match?.[1] ?? null;
}

function buildWatchdogComment(ctx: WatchdogStuckWritebackContext, marker: string): string {
  const worktreePath = ctx.worktreePath ? redactHomePathForDisplay(ctx.worktreePath) : "(unknown)";
  const sessionId = ctx.sessionId?.trim() || "(unknown)";
  const source = ctx.timeout?.source ?? "tool-watchdog";
  const toolName = ctx.timeout?.toolName ?? "unknown";
  const callId = ctx.timeout?.callId ?? "unknown";
  const elapsedSec = ctx.timeout?.elapsedMs ? Math.round(ctx.timeout.elapsedMs / 1000) : null;
  const timeoutLine = `Timeout: ${toolName} ${callId}${elapsedSec ? ` after ${elapsedSec}s` : ""} (${source})`;
  const issueUrl = `https://github.com/${ctx.repo}/issues/${ctx.issueNumber}`;

  const recentEvents = ctx.timeout?.recentEvents ?? [];
  const sanitizedEvents = recentEvents
    .slice(-MAX_EVENT_LINES)
    .map((line) => truncateText(sanitizeEscalationReason(line), MAX_EVENT_CHARS));

  const lastSnippet = sanitizedEvents
    .slice()
    .reverse()
    .find((line) => /anomaly|error|exception|failed|traceback/i.test(line));

  const commands = (ctx.suggestedCommands?.length ? ctx.suggestedCommands : DEFAULT_COMMANDS)
    .map((cmd) => cmd.trim())
    .filter(Boolean);

  const body: string[] = [
    marker,
    "Ralph hit a watchdog timeout and will retry once with a fresh OpenCode session.",
    "",
    `Issue: ${issueUrl}`,
    `Stage: ${ctx.stage}`,
    `Session: ${sessionId}`,
    `Worktree: ${worktreePath}`,
    timeoutLine,
    "",
    "Recent OpenCode events (bounded):",
  ];

  if (sanitizedEvents.length > 0) {
    body.push(...sanitizedEvents.map((line) => `- ${line}`));
  } else {
    body.push("- (no recent events captured)");
  }

  if (lastSnippet) {
    body.push("", "Last anomaly/error snippet:", "```", truncateText(lastSnippet, MAX_SNIPPET_CHARS), "```");
  }

  if (commands.length > 0) {
    body.push("", "Suggested deterministic commands:");
    body.push(...commands.map((cmd) => `- ${cmd}`));
  }

  const reason = ctx.timeout
    ? `Tool call timed out: ${toolName} ${callId} after ${elapsedSec ?? "?"}s (${ctx.stage})`
    : `Tool call timed out (${ctx.stage})`;
  body.push("", "Reason:", truncateText(sanitizeEscalationReason(reason), MAX_REASON_CHARS));

  return body.join("\n");
}

export function planWatchdogStuckWriteback(ctx: WatchdogStuckWritebackContext): WatchdogStuckWritebackPlan {
  const marker = buildWatchdogStuckMarker({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    stage: ctx.stage,
    retryIndex: ctx.retryIndex,
    signatureHash: ctx.signatureHash,
    sessionId: ctx.sessionId,
  });
  const markerId = extractExistingWatchdogMarker(marker) ?? "";
  const commentBody = buildWatchdogComment(ctx, marker);
  const idempotencyKey = `gh-watchdog-stuck:${ctx.repo}#${ctx.issueNumber}:${markerId}`;

  return {
    marker,
    markerId,
    commentBody,
    addLabels: [RALPH_LABEL_STUCK],
    removeLabels: [],
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
          url
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
        issue?: { comments?: { nodes?: Array<{ body?: string | null; url?: string | null }>; pageInfo?: { hasPreviousPage?: boolean } } };
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
  const comments = nodes.map((node) => ({ body: node?.body ?? "", url: node?.url ?? null }));
  const reachedMax = Boolean(response.data?.data?.repository?.issue?.comments?.pageInfo?.hasPreviousPage);

  return { comments, reachedMax };
}

async function createIssueComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<string | null> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<{ html_url?: string | null }>(
    `/repos/${owner}/${name}/issues/${params.issueNumber}/comments`,
    {
      method: "POST",
      body: { body: params.body },
    }
  );
  return response.data?.html_url ?? null;
}

function extractCommentUrl(payloadJson: string | null | undefined): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { commentUrl?: string | null };
    return parsed.commentUrl ?? null;
  } catch {
    return null;
  }
}

export async function writeWatchdogStuckToGitHub(
  ctx: WatchdogStuckWritebackContext,
  deps: WritebackDeps
): Promise<WatchdogStuckWritebackResult> {
  const overrideCount = [deps.hasIdempotencyKey, deps.recordIdempotencyKey, deps.deleteIdempotencyKey, deps.getIdempotencyPayload].filter(
    Boolean
  ).length;
  if (overrideCount > 0 && overrideCount < 4) {
    throw new Error("writeWatchdogStuckToGitHub requires all idempotency overrides when any are provided");
  }
  if (overrideCount === 0) {
    initStateDb();
  }

  const plan = planWatchdogStuckWriteback(ctx);
  const log = deps.log ?? console.log;
  const commentLimit = Math.min(Math.max(1, deps.commentScanLimit ?? DEFAULT_COMMENT_SCAN_LIMIT), 100);
  const hasKey = deps.hasIdempotencyKey ?? hasIdempotencyKey;
  const recordKey = deps.recordIdempotencyKey ?? recordIdempotencyKey;
  const deleteKey = deps.deleteIdempotencyKey ?? deleteIdempotencyKey;
  const readPayload = deps.getIdempotencyPayload ?? getIdempotencyPayload;
  const prefix = `[ralph:gh-watchdog-stuck:${ctx.repo}]`;

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

  let markerCommentUrl: string | null = null;
  const markerId = plan.markerId.toLowerCase();
  const markerFound =
    listResult?.comments.some((comment) => {
      const body = comment.body ?? "";
      const found = extractExistingWatchdogMarker(body);
      const matched = found ? found.toLowerCase() === markerId : body.includes(plan.marker);
      if (matched && comment.url) markerCommentUrl = comment.url;
      return matched;
    }) ?? false;

  const payloadUrl = extractCommentUrl(readPayload(plan.idempotencyKey));

  if (hasKeyResult && markerFound) {
    log(`${prefix} Watchdog comment already recorded (idempotency + marker); skipping.`);
    return { postedComment: false, skippedComment: true, markerFound: true, commentUrl: markerCommentUrl ?? payloadUrl };
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
      recordKey({
        key: plan.idempotencyKey,
        scope: "gh-watchdog-stuck",
        payloadJson: markerCommentUrl ? JSON.stringify({ commentUrl: markerCommentUrl }) : undefined,
      });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after marker match: ${error?.message ?? String(error)}`);
    }
    log(`${prefix} Existing watchdog marker found for #${ctx.issueNumber}; skipping comment.`);
    return { postedComment: false, skippedComment: true, markerFound: true, commentUrl: markerCommentUrl ?? payloadUrl };
  }

  let claimed = false;
  try {
    claimed = recordKey({ key: plan.idempotencyKey, scope: "gh-watchdog-stuck" });
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
      log(`${prefix} Watchdog comment already claimed; skipping comment.`);
      return { postedComment: false, skippedComment: true, markerFound: false, commentUrl: payloadUrl };
    }
  }

  let commentUrl: string | null = null;
  try {
    commentUrl = await createIssueComment({
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
      recordKey({
        key: plan.idempotencyKey,
        scope: "gh-watchdog-stuck",
        payloadJson: commentUrl ? JSON.stringify({ commentUrl }) : undefined,
      });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after posting comment: ${error?.message ?? String(error)}`);
    }
  }

  log(`${prefix} Posted watchdog comment for #${ctx.issueNumber}.`);
  return { postedComment: true, skippedComment: false, markerFound: false, commentUrl };
}
