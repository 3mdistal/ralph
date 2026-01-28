import { splitRepoFullName, type GitHubClient } from "./client";
import { sanitizeEscalationReason } from "./escalation-writeback";
import { initStateDb, hasIdempotencyKey, recordIdempotencyKey, deleteIdempotencyKey } from "../state";

export type RollupReadyContext = {
  repo: string;
  prNumber: number;
  prUrl: string;
  mergedPRs: string[];
};

export type RollupReadyPlan = {
  marker: string;
  markerId: string;
  commentBody: string;
  idempotencyKey: string;
};

export type RollupReadyResult = {
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
};

type IssueComment = { body?: string | null };

const ROLLUP_MARKER_PREFIX = "<!-- ralph-rollup-ready:id=";
const ROLLUP_MARKER_REGEX = /<!--\s*ralph-rollup-ready:id=([a-f0-9]+)\s*-->/i;
const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const MAX_COMMENT_CHARS = 8000;
const MAX_LIST_ITEMS = 50;

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

function buildMarkerId(params: { repo: string; prNumber: number }): string {
  const base = [params.repo, params.prNumber].join("|");
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildMarker(params: { repo: string; prNumber: number }): string {
  const markerId = buildMarkerId(params);
  return `${ROLLUP_MARKER_PREFIX}${markerId} -->`;
}

export function extractExistingRollupMarker(body: string): string | null {
  const match = body.match(ROLLUP_MARKER_REGEX);
  return match?.[1] ?? null;
}

function formatMergedPrs(mergedPRs: string[]): string[] {
  const trimmed = mergedPRs.map((pr) => sanitizeEscalationReason(pr).trim()).filter(Boolean);
  if (trimmed.length <= MAX_LIST_ITEMS) return trimmed.map((pr) => `- ${pr}`);
  const head = trimmed.slice(0, MAX_LIST_ITEMS).map((pr) => `- ${pr}`);
  const remainder = trimmed.length - MAX_LIST_ITEMS;
  return [...head, `- ...and ${remainder} more`];
}

export function planRollupReadyWriteback(ctx: RollupReadyContext): RollupReadyPlan {
  const marker = buildMarker({ repo: ctx.repo, prNumber: ctx.prNumber });
  const markerId = buildMarkerId({ repo: ctx.repo, prNumber: ctx.prNumber });

  const lines = [
    marker,
    `A rollup PR is ready for review in **${ctx.repo}**.`,
    "",
    `**Rollup PR:** ${ctx.prUrl}`,
    "",
    `**Included PRs (${ctx.mergedPRs.length}):**`,
    ...formatMergedPrs(ctx.mergedPRs),
    "",
    "Please review and merge to main when ready.",
  ];

  return {
    marker,
    markerId,
    commentBody: truncateText(lines.join("\n"), MAX_COMMENT_CHARS),
    idempotencyKey: `gh-rollup-ready:${ctx.repo}#${ctx.prNumber}:${markerId}`,
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

export async function writeRollupReadyToGitHub(ctx: RollupReadyContext, deps: WritebackDeps): Promise<RollupReadyResult> {
  const overrideCount = [deps.hasIdempotencyKey, deps.recordIdempotencyKey, deps.deleteIdempotencyKey].filter(Boolean)
    .length;
  if (overrideCount > 0 && overrideCount < 3) {
    throw new Error("writeRollupReadyToGitHub requires all idempotency overrides when any are provided");
  }
  if (overrideCount === 0) {
    initStateDb();
  }

  const plan = planRollupReadyWriteback(ctx);
  const log = deps.log ?? console.log;
  const commentLimit = Math.min(Math.max(1, deps.commentScanLimit ?? DEFAULT_COMMENT_SCAN_LIMIT), 100);
  const hasKey = deps.hasIdempotencyKey ?? hasIdempotencyKey;
  const recordKey = deps.recordIdempotencyKey ?? recordIdempotencyKey;
  const deleteKey = deps.deleteIdempotencyKey ?? deleteIdempotencyKey;
  const prefix = `[ralph:gh-rollup-ready:${ctx.repo}]`;

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
      issueNumber: ctx.prNumber,
      limit: commentLimit,
    });
  } catch (error: any) {
    log(`${prefix} Failed to list PR comments: ${error?.message ?? String(error)}`);
  }

  if (listResult?.reachedMax) {
    log(`${prefix} Comment scan hit cap (${commentLimit}); marker detection may be incomplete.`);
  }

  const markerId = plan.markerId.toLowerCase();
  const markerFound =
    listResult?.comments.some((comment) => {
      const body = comment.body ?? "";
      const found = extractExistingRollupMarker(body);
      return found ? found.toLowerCase() === markerId : body.includes(plan.marker);
    }) ?? false;

  if (hasKeyResult && markerFound) {
    log(`${prefix} Rollup-ready comment already recorded (idempotency + marker); skipping.`);
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
      recordKey({ key: plan.idempotencyKey, scope: "gh-rollup-ready" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after marker match: ${error?.message ?? String(error)}`);
    }
    log(`${prefix} Existing rollup-ready marker found for PR #${ctx.prNumber}; skipping comment.`);
    return { postedComment: false, skippedComment: true, markerFound: true, commentUrl: null };
  }

  let claimed = false;
  try {
    claimed = recordKey({ key: plan.idempotencyKey, scope: "gh-rollup-ready" });
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
      log(`${prefix} Rollup-ready comment already claimed; skipping comment.`);
      return { postedComment: false, skippedComment: true, markerFound: false, commentUrl: null };
    }
  }

  let commentUrl: string | null = null;
  try {
    const comment = await createIssueComment({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.prNumber,
      body: plan.commentBody,
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

  if (!claimed) {
    try {
      recordKey({ key: plan.idempotencyKey, scope: "gh-rollup-ready" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after posting comment: ${error?.message ?? String(error)}`);
    }
  }

  log(`${prefix} Posted rollup-ready comment for PR #${ctx.prNumber}.`);
  return { postedComment: true, skippedComment: false, markerFound: false, commentUrl };
}
