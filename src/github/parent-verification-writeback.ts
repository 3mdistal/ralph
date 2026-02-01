import { GitHubClient, splitRepoFullName } from "./client";
import { initStateDb, hasIdempotencyKey, recordIdempotencyKey, deleteIdempotencyKey } from "../state";
import { buildParentVerificationComment, type ParentVerificationEvidence } from "../parent-verification/core";
import { executeIssueLabelOps, planIssueLabelOps } from "./issue-label-io";
import type { IssueRef } from "./issue-ref";

export type ParentVerificationContext = {
  repo: string;
  issueNumber: number;
  childIssues: IssueRef[];
  evidence: ParentVerificationEvidence[];
};

export type ParentVerificationWritebackResult = {
  ok: boolean;
  commentUrl?: string | null;
  closed: boolean;
  labelOpsApplied: boolean;
  error?: string;
};

type WritebackDeps = {
  github: GitHubClient;
  commentScanLimit?: number;
  log?: (message: string) => void;
};

type IssueComment = { body?: string | null; databaseId?: number | null; url?: string | null };

const MARKER_PREFIX = "<!-- ralph-parent-verify:id=";
const MARKER_REGEX = /<!--\s*ralph-parent-verify:id=([^\s]+)\s*-->/i;
const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const LABELS_TO_REMOVE = ["ralph:status:queued", "ralph:status:blocked", "ralph:status:in-progress"];

function hashFNV1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildMarkerId(params: { repo: string; issueNumber: number }): string {
  const base = `parent-verify:v1|${params.repo}|${params.issueNumber}`;
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildMarker(params: { repo: string; issueNumber: number }): string {
  const markerId = buildMarkerId(params);
  return `${MARKER_PREFIX}${markerId} -->`;
}

function extractExistingMarker(body: string): string | null {
  const match = body.match(MARKER_REGEX);
  return match?.[1] ?? null;
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
            nodes?: Array<{ body?: string | null; databaseId?: number | null; url?: string | null }>;
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
}): Promise<{ html_url?: string | null; id?: number | null }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<{ html_url?: string | null; id?: number | null }>(
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

async function closeIssue(params: { github: GitHubClient; repo: string; issueNumber: number }): Promise<void> {
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}`, {
    method: "PATCH",
    body: { state: "closed" },
  });
}

export async function writeParentVerificationToGitHub(
  ctx: ParentVerificationContext,
  deps: WritebackDeps
): Promise<ParentVerificationWritebackResult> {
  initStateDb();
  const log = deps.log ?? console.log;
  const commentLimit = Math.min(Math.max(1, deps.commentScanLimit ?? DEFAULT_COMMENT_SCAN_LIMIT), 100);
  const marker = buildMarker({ repo: ctx.repo, issueNumber: ctx.issueNumber });
  const markerId = buildMarkerId({ repo: ctx.repo, issueNumber: ctx.issueNumber });
  const commentBody = buildParentVerificationComment({ marker, childIssues: ctx.childIssues, evidence: ctx.evidence });
  const idempotencyKey = `gh-parent-verify:${ctx.repo}#${ctx.issueNumber}:${markerId}`;
  const prefix = `[ralph:gh-parent-verify:${ctx.repo}]`;

  let commentOk = false;
  let commentUrl: string | null = null;

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

  const markerFoundComment = listResult?.comments.find((comment) => {
    const body = comment.body ?? "";
    const found = extractExistingMarker(body);
    return found ? found.toLowerCase() === markerId.toLowerCase() : body.includes(marker);
  });

  if (markerFoundComment) {
    commentOk = true;
    const commentId = markerFoundComment.databaseId ?? null;
    commentUrl = markerFoundComment.url ?? null;
    if (commentId) {
      try {
        const updated = await updateIssueComment({
          github: deps.github,
          repo: ctx.repo,
          commentId,
          body: commentBody,
        });
        commentUrl = updated?.html_url ?? commentUrl;
      } catch (error: any) {
        log(`${prefix} Failed to update existing verification comment: ${error?.message ?? String(error)}`);
      }
    }
    recordIdempotencyKey({ key: idempotencyKey, scope: "gh-parent-verify" });
  }

  if (!commentOk) {
    const hasKey = hasIdempotencyKey(idempotencyKey);
    const scanComplete = listResult ? !listResult.reachedMax : false;
    if (hasKey && scanComplete) {
      deleteIdempotencyKey(idempotencyKey);
    } else if (hasKey && !scanComplete) {
      log(`${prefix} Idempotency key exists but marker scan incomplete; assuming comment exists.`);
      commentOk = true;
    }
  }

  if (!commentOk) {
    const claimed = recordIdempotencyKey({ key: idempotencyKey, scope: "gh-parent-verify" });
    if (!claimed) {
      commentOk = true;
    } else {
      try {
        const created = await createIssueComment({
          github: deps.github,
          repo: ctx.repo,
          issueNumber: ctx.issueNumber,
          body: commentBody,
        });
        commentUrl = created?.html_url ?? commentUrl;
        commentOk = true;
      } catch (error: any) {
        deleteIdempotencyKey(idempotencyKey);
        return {
          ok: false,
          closed: false,
          labelOpsApplied: false,
          error: `Failed to create verification comment: ${error?.message ?? String(error)}`,
        };
      }
    }
  }

  if (!commentOk) {
    return { ok: false, closed: false, labelOpsApplied: false, error: "Verification comment missing" };
  }

  try {
    await closeIssue({ github: deps.github, repo: ctx.repo, issueNumber: ctx.issueNumber });
  } catch (error: any) {
    return {
      ok: false,
      closed: false,
      labelOpsApplied: false,
      commentUrl,
      error: `Failed to close issue: ${error?.message ?? String(error)}`,
    };
  }

  let labelOpsApplied = false;
  try {
    const ops = planIssueLabelOps({ add: [], remove: LABELS_TO_REMOVE });
    const result = await executeIssueLabelOps({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      ops,
      log: (message) => log(`${prefix} ${message}`),
      logLabel: `${ctx.repo}#${ctx.issueNumber}`,
      ensureBefore: false,
      retryMissingLabelOnce: true,
    });
    labelOpsApplied = result.ok || result.kind === "transient";
  } catch (error: any) {
    log(`${prefix} Failed to remove verification labels: ${error?.message ?? String(error)}`);
  }

  return { ok: true, commentUrl, closed: true, labelOpsApplied };
}
