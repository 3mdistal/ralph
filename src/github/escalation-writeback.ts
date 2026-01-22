import { deleteIdempotencyKey, hasIdempotencyKey, recordIdempotencyKey } from "../state";
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
  maxCommentPages?: number;
  log?: (message: string) => void;
  hasIdempotencyKey?: (key: string) => boolean;
  recordIdempotencyKey?: (input: { key: string; scope?: string; payloadJson?: string }) => boolean;
};

const DEFAULT_OWNER_HANDLE = "@3mdistal";
const DEFAULT_MAX_COMMENT_PAGES = 5;
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

export function buildEscalationMarker(params: {
  repo: string;
  issueNumber: number;
  taskPath: string;
  escalationType: string;
}): string {
  const base = [params.repo, params.issueNumber, params.taskPath, params.escalationType].join("|");
  const hash = `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
  return `<!-- ralph-escalation:id=${hash} -->`;
}

export function extractExistingMarker(body: string): string | null {
  const match = body.match(/<!--\s*ralph-escalation:id=([a-f0-9]+)\s*-->/i);
  return match?.[1] ?? null;
}

export function buildEscalationComment(params: {
  marker: string;
  taskName: string;
  issueUrl: string;
  reason: string;
  ownerHandle: string;
}): string {
  const owner = params.ownerHandle.trim() || DEFAULT_OWNER_HANDLE;
  const reason = truncateText(params.reason, MAX_REASON_CHARS) || "(no reason provided)";

  return [
    params.marker,
    `${owner} Ralph needs a decision to proceed on **${params.taskName}**.`,
    "",
    `Issue: ${params.issueUrl}`,
    "",
    "Reason:",
    reason,
    "",
    "To resolve:",
    "1. Comment with `RALPH RESOLVED: <guidance>` to resume with guidance.",
    "2. Or re-add the `ralph:queued` label to resume without extra guidance. Ralph will remove `ralph:escalated`.",
  ].join("\n");
}

export function planEscalationWriteback(ctx: EscalationWritebackContext): EscalationWritebackPlan {
  const repoOwner = ctx.repo.split("/")[0] ?? "";
  const ownerHandle = ctx.ownerHandle?.trim() || (repoOwner ? `@${repoOwner}` : DEFAULT_OWNER_HANDLE);
  const marker = buildEscalationMarker({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    taskPath: ctx.taskPath,
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

  const markerId = extractExistingMarker(marker) ?? marker;
  const idempotencyKey = `gh-escalation:${ctx.repo}#${ctx.issueNumber}:${markerId}`;

  return {
    marker,
    markerId,
    commentBody,
    addLabels: ["ralph:escalated"],
    removeLabels: ["ralph:in-progress", "ralph:queued"],
    idempotencyKey,
  };
}

async function listIssueComments(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  maxPages: number;
}): Promise<{ comments: IssueComment[]; reachedMax: boolean }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const comments: IssueComment[] = [];
  let reachedMax = false;

  for (let page = 1; page <= params.maxPages; page += 1) {
    const response = await params.github.request<IssueComment[]>(
      `/repos/${owner}/${name}/issues/${params.issueNumber}/comments?per_page=100&page=${page}`
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    comments.push(...rows);
    if (rows.length < 100) break;
    if (page === params.maxPages) reachedMax = true;
  }

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
  const plan = planEscalationWriteback(ctx);
  const log = deps.log ?? console.log;
  const maxPages = deps.maxCommentPages ?? DEFAULT_MAX_COMMENT_PAGES;
  const hasKey = deps.hasIdempotencyKey ?? hasIdempotencyKey;
  const recordKey = deps.recordIdempotencyKey ?? recordIdempotencyKey;
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
  try {
    hasKeyResult = hasKey(plan.idempotencyKey);
  } catch (error: any) {
    log(`${prefix} Failed to check idempotency: ${error?.message ?? String(error)}`);
  }

  if (hasKeyResult) {
    log(`${prefix} Escalation comment already recorded (idempotency); skipping.`);
    return { postedComment: false, skippedComment: true, markerFound: true };
  }

  const listResult = await listIssueComments({
    github: deps.github,
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    maxPages,
  });

  if (listResult.reachedMax) {
    log(`${prefix} Comment scan hit page cap (${maxPages}); marker detection may be incomplete.`);
  }

  const markerFound = listResult.comments.some((comment) => {
    const body = comment.body ?? "";
    const found = extractExistingMarker(body);
    return found ? found === plan.markerId : body.includes(plan.marker);
  });
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

  if (!claimed) {
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
        deleteIdempotencyKey(plan.idempotencyKey);
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
