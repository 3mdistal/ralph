import {
  deleteIdempotencyKey,
  getIdempotencyPayload,
  hasIdempotencyKey,
  initStateDb,
  recordIdempotencyKey,
  upsertIdempotencyKey,
} from "../state";
import {
  RALPH_LABEL_ESCALATED,
  RALPH_LABEL_IN_PROGRESS,
  RALPH_LABEL_QUEUED,
  RALPH_LABEL_STUCK,
  RALPH_ESCALATION_MARKER_REGEX,
  RALPH_RESOLVED_TEXT,
  type EscalationType,
} from "./escalation-constants";
import { GitHubApiError, GitHubClient, splitRepoFullName } from "./client";
import { ensureRalphWorkflowLabelsOnce } from "./ensure-ralph-workflow-labels";
import { executeIssueLabelOps, type LabelOp } from "./issue-label-io";

export type EscalationWritebackContext = {
  repo: string;
  issueNumber: number;
  taskName: string;
  taskPath: string;
  reason: string;
  details?: string;
  escalationType: EscalationType;
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
  commentUrl?: string | null;
};

type IssueComment = {
  body?: string | null;
  databaseId?: number | null;
  createdAt?: string | null;
  url?: string | null;
};

type WritebackDeps = {
  github: GitHubClient;
  commentScanLimit?: number;
  log?: (message: string) => void;
  hasIdempotencyKey?: (key: string) => boolean;
  recordIdempotencyKey?: (input: { key: string; scope?: string; payloadJson?: string }) => boolean;
  deleteIdempotencyKey?: (key: string) => void;
  getIdempotencyPayload?: (key: string) => string | null;
  upsertIdempotencyKey?: (input: { key: string; scope?: string; payloadJson?: string; createdAt?: string }) => void;
};

const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const MAX_REASON_CHARS = 500;
const MAX_DETAILS_CHARS = 5000;
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

function normalizeEscalationBody(body: string): string {
  const trimmed = String(body ?? "").trimEnd();
  return `${trimmed}\n`;
}

function isMissingCommentError(error: unknown): boolean {
  return error instanceof GitHubApiError && (error.status === 404 || error.status === 410);
}

function parseBodyHash(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { bodyHash?: unknown };
    return typeof parsed?.bodyHash === "string" ? parsed.bodyHash : null;
  } catch {
    return null;
  }
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickNewestComment(comments: IssueComment[]): IssueComment | null {
  return comments.reduce<IssueComment | null>((latest, current) => {
    if (!latest) return current;
    const latestTime = parseIsoMs(latest.createdAt);
    const currentTime = parseIsoMs(current.createdAt);
    if (currentTime !== null && (latestTime === null || currentTime > latestTime)) {
      return current;
    }
    if (currentTime === null && latestTime === null) {
      const latestId = latest.databaseId ?? -1;
      const currentId = current.databaseId ?? -1;
      if (currentId > latestId) return current;
      if (currentId === -1 && latestId === -1) return current;
    }
    return latest;
  }, null);
}

function commentMatchesMarker(params: { body: string; markerId: string; marker: string }): boolean {
  const found = extractExistingMarker(params.body);
  if (found) return found.toLowerCase() === params.markerId;
  return params.body.includes(params.marker);
}

export function sanitizeEscalationReason(input: string): string {
  let out = input.replace(/\x1b\[[0-9;]*m/g, "");
  const patterns: Array<{ re: RegExp; replacement: string }> = [
    { re: /ghp_[A-Za-z0-9]{20,}/g, replacement: "ghp_[REDACTED]" },
    { re: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "github_pat_[REDACTED]" },
    { re: /sk-[A-Za-z0-9]{20,}/g, replacement: "sk-[REDACTED]" },
    { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "xox-[REDACTED]" },
    { re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
    { re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
    { re: /\/home\/[A-Za-z0-9._-]+\//g, replacement: "~/" },
    { re: /\/Users\/[A-Za-z0-9._-]+\//g, replacement: "~/" },
  ];

  for (const { re, replacement } of patterns) {
    out = out.replace(re, replacement);
  }

  return out;
}

function buildEscalationMarkerId(params: {
  repo: string;
  issueNumber: number;
  escalationType: EscalationType;
}): string {
  const base = [params.repo, params.issueNumber, params.escalationType].join("|");
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

export function buildEscalationMarker(params: {
  repo: string;
  issueNumber: number;
  escalationType: EscalationType;
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
  details?: string;
  ownerHandle: string;
}): string {
  const owner = params.ownerHandle.trim();
  const mention = owner ? `${owner} ` : "";
  const sanitized = sanitizeEscalationReason(params.reason);
  const reason = truncateText(sanitized, MAX_REASON_CHARS) || "(no reason provided)";
  const rawDetails = params.details ? sanitizeEscalationReason(params.details) : "";
  const details = rawDetails ? truncateText(rawDetails, MAX_DETAILS_CHARS) : "";

  return [
    params.marker,
    `${mention}Ralph needs a decision to proceed on **${params.taskName}**.`,
    "",
    `Issue: ${params.issueUrl}`,
    "",
    "Reason:",
    reason,
    details ? "" : null,
    details ? "Details:" : null,
    details || null,
    "",
    "To resolve:",
    `1. Comment with \`${RALPH_RESOLVED_TEXT} <guidance>\` to resume with guidance.`,
    `2. Or re-add the \`${RALPH_LABEL_QUEUED}\` label to resume without extra guidance. Ralph will remove \`${
      RALPH_LABEL_ESCALATED
    }\`.`,
  ].join("\n");
}

export type EscalationCommentPlan = {
  action: "noop" | "patch" | "post";
  body: string;
  markerFound: boolean;
  targetCommentId?: number;
  targetCommentUrl?: string | null;
};

export function planEscalationCommentWrite(params: {
  desiredBody: string;
  markerId: string;
  marker: string;
  scannedComments: IssueComment[];
}): EscalationCommentPlan {
  const normalizedBody = normalizeEscalationBody(params.desiredBody);
  const markerId = params.markerId.toLowerCase();
  const matches = params.scannedComments.filter((comment) =>
    commentMatchesMarker({ body: comment.body ?? "", markerId, marker: params.marker })
  );

  if (matches.length > 0) {
    const target = pickNewestComment(matches);
    const targetBody = normalizeEscalationBody(target?.body ?? "");
    if (targetBody === normalizedBody) {
      return {
        action: "noop",
        body: normalizedBody,
        markerFound: true,
        targetCommentId: target?.databaseId ?? undefined,
        targetCommentUrl: target?.url ?? null,
      };
    }
    if (target?.databaseId) {
      return {
        action: "patch",
        body: normalizedBody,
        markerFound: true,
        targetCommentId: target.databaseId,
        targetCommentUrl: target.url ?? null,
      };
    }
    return { action: "post", body: normalizedBody, markerFound: true };
  }

  return { action: "post", body: normalizedBody, markerFound: false };
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
    details: ctx.details,
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
    removeLabels: [RALPH_LABEL_IN_PROGRESS, RALPH_LABEL_QUEUED, RALPH_LABEL_STUCK],
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
          databaseId
          createdAt
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
        issue?: {
          comments?: {
            nodes?: Array<{
              body?: string | null;
              databaseId?: number | null;
              createdAt?: string | null;
              url?: string | null;
            }>;
            pageInfo?: { hasPreviousPage?: boolean };
          };
        };
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
  const comments = nodes.map((node) => ({
    body: node?.body ?? "",
    databaseId: typeof node?.databaseId === "number" ? node.databaseId : null,
    createdAt: node?.createdAt ?? null,
    url: node?.url ?? null,
  }));
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

async function updateIssueComment(params: {
  github: GitHubClient;
  repo: string;
  commentId: number;
  body: string;
}): Promise<{ html_url?: string | null }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<{ html_url?: string | null }>(
    `/repos/${owner}/${name}/issues/comments/${params.commentId}`,
    {
      method: "PATCH",
      body: { body: params.body },
    }
  );
  return response.data ?? {};
}

function buildEscalationLabelOps(plan: EscalationWritebackPlan): LabelOp[] {
  return [
    ...plan.removeLabels.map((label) => ({ action: "remove" as const, label })),
    ...plan.addLabels.map((label) => ({ action: "add" as const, label })),
  ];
}

export async function writeEscalationToGitHub(
  ctx: EscalationWritebackContext,
  deps: WritebackDeps
): Promise<EscalationWritebackResult> {
  const overrideCount = [
    deps.hasIdempotencyKey,
    deps.recordIdempotencyKey,
    deps.deleteIdempotencyKey,
    deps.getIdempotencyPayload,
    deps.upsertIdempotencyKey,
  ].filter(Boolean).length;
  if (overrideCount > 0 && overrideCount < 5) {
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
  const getPayload = deps.getIdempotencyPayload ?? getIdempotencyPayload;
  const upsertKey = deps.upsertIdempotencyKey ?? upsertIdempotencyKey;
  const prefix = `[ralph:gh-escalation:${ctx.repo}]`;

  const labelOps = buildEscalationLabelOps(plan);
  if (labelOps.length > 0) {
    const labelResult = await executeIssueLabelOps({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      ops: labelOps,
      log: (message) => log(`${prefix} ${message}`),
      logLabel: `${ctx.repo}#${ctx.issueNumber}`,
      ensureLabels: async () => await ensureRalphWorkflowLabelsOnce({ repo: ctx.repo, github: deps.github }),
      retryMissingLabelOnce: true,
      ensureBefore: true,
    });
    if (!labelResult.ok) {
      log(`${prefix} Failed to update escalation labels for #${ctx.issueNumber}; continuing.`);
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

  const scanComplete = Boolean(listResult && !listResult.reachedMax);
  let commentPlan = planEscalationCommentWrite({
    desiredBody: plan.commentBody,
    markerId: plan.markerId,
    marker: plan.marker,
    scannedComments: listResult?.comments ?? [],
  });
  const desiredBodyHash = hashFNV1a(commentPlan.body);

  if (commentPlan.action === "noop") {
    try {
      upsertKey({
        key: plan.idempotencyKey,
        scope: "gh-escalation",
        payloadJson: JSON.stringify({ bodyHash: desiredBodyHash }),
      });
    } catch (error: any) {
      log(`${prefix} Failed to update idempotency after noop: ${error?.message ?? String(error)}`);
    }
    log(`${prefix} Escalation comment already up to date for #${ctx.issueNumber}; skipping.`);
    return {
      postedComment: false,
      skippedComment: true,
      markerFound: true,
      commentUrl: commentPlan.targetCommentUrl ?? null,
    };
  }

  if (commentPlan.action === "patch") {
    let commentUrl: string | null = commentPlan.targetCommentUrl ?? null;
    try {
      const comment = await updateIssueComment({
        github: deps.github,
        repo: ctx.repo,
        commentId: commentPlan.targetCommentId ?? 0,
        body: commentPlan.body,
      });
      commentUrl = comment?.html_url ?? commentUrl;
      try {
        upsertKey({
          key: plan.idempotencyKey,
          scope: "gh-escalation",
          payloadJson: JSON.stringify({ bodyHash: desiredBodyHash }),
        });
      } catch (error: any) {
        log(`${prefix} Failed to update idempotency after patch: ${error?.message ?? String(error)}`);
      }
      log(`${prefix} Updated escalation comment for #${ctx.issueNumber}.`);
      return { postedComment: false, skippedComment: false, markerFound: true, commentUrl };
    } catch (error) {
      if (!isMissingCommentError(error)) {
        throw error;
      }
      log(`${prefix} Escalation comment missing; posting a fresh comment.`);
      commentPlan = { ...commentPlan, action: "post" };
      ignoreExistingKey = true;
    }
  }

  if (hasKeyResult && scanComplete && !commentPlan.markerFound) {
    ignoreExistingKey = true;
    try {
      deleteKey(plan.idempotencyKey);
    } catch (error: any) {
      log(`${prefix} Failed to clear stale idempotency key: ${error?.message ?? String(error)}`);
    }
  }

  if (hasKeyResult && !scanComplete && !commentPlan.markerFound) {
    let priorHash: string | null = null;
    try {
      priorHash = parseBodyHash(getPayload(plan.idempotencyKey));
    } catch (error: any) {
      log(`${prefix} Failed to read idempotency payload: ${error?.message ?? String(error)}`);
    }
    if (priorHash && priorHash === desiredBodyHash) {
      log(`${prefix} Escalation comment already recorded (idempotency payload match); skipping.`);
      return { postedComment: false, skippedComment: true, markerFound: false, commentUrl: null };
    }
    ignoreExistingKey = true;
    log(`${prefix} Idempotency key exists but marker scan incomplete; proceeding to post updated escalation.`);
  }

  let claimed = false;
  try {
    claimed = recordKey({
      key: plan.idempotencyKey,
      scope: "gh-escalation",
      payloadJson: JSON.stringify({ bodyHash: desiredBodyHash }),
    });
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
      return { postedComment: false, skippedComment: true, markerFound: false, commentUrl: null };
    }
  }

  let commentUrl: string | null = null;
  try {
    const comment = await createIssueComment({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      body: commentPlan.body,
    });
    commentUrl = comment?.html_url ?? null;
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

  try {
    upsertKey({
      key: plan.idempotencyKey,
      scope: "gh-escalation",
      payloadJson: JSON.stringify({ bodyHash: desiredBodyHash }),
    });
  } catch (error: any) {
    log(`${prefix} Failed to update idempotency after posting comment: ${error?.message ?? String(error)}`);
  }

  log(`${prefix} Posted escalation comment for #${ctx.issueNumber}.`);

  return {
    postedComment: true,
    skippedComment: false,
    markerFound: commentPlan.markerFound,
    commentUrl,
  };
}
