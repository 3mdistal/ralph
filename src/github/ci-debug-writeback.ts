import { GitHubClient, splitRepoFullName } from "./client";

const CI_DEBUG_MARKER_PREFIX = "<!-- ralph-ci-debug:id=";
const CI_DEBUG_MARKER_REGEX = /<!--\s*ralph-ci-debug:id=([a-f0-9]+)\s*-->/i;
const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

export type CiDebugWritebackResult = {
  commentId: number | null;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  markerFound: boolean;
};

type IssueCommentNode = { body?: string | null; databaseId?: number | null };

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildCiDebugMarkerId(params: { repo: string; prNumber: number }): string {
  const base = [params.repo, params.prNumber, "v1"].join("|");
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

export function buildCiDebugMarker(params: { repo: string; prNumber: number }): string {
  const markerId = buildCiDebugMarkerId(params);
  return `${CI_DEBUG_MARKER_PREFIX}${markerId} -->`;
}

export function extractCiDebugMarker(body: string): string | null {
  const match = body.match(CI_DEBUG_MARKER_REGEX);
  return match?.[1] ?? null;
}

async function listRecentIssueComments(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  limit: number;
}): Promise<{ comments: IssueCommentNode[]; reachedMax: boolean }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!, $last: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: $last) {
        nodes {
          body
          databaseId
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
          comments?: { nodes?: IssueCommentNode[]; pageInfo?: { hasPreviousPage?: boolean } };
        };
      };
    };
  }>("/graphql", {
    method: "POST",
    body: { query, variables: { owner, name, number: params.issueNumber, last: params.limit } },
  });

  const nodes = response.data?.data?.repository?.issue?.comments?.nodes ?? [];
  const hasPreviousPage = response.data?.data?.repository?.issue?.comments?.pageInfo?.hasPreviousPage ?? false;
  return { comments: nodes, reachedMax: hasPreviousPage };
}

async function findExistingCiDebugComment(params: {
  github: GitHubClient;
  repo: string;
  prNumber: number;
  markerId: string;
  scanLimit: number;
}): Promise<{ commentId: number | null; reachedMax: boolean }> {
  const { comments, reachedMax } = await listRecentIssueComments({
    github: params.github,
    repo: params.repo,
    issueNumber: params.prNumber,
    limit: params.scanLimit,
  });

  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body.includes(CI_DEBUG_MARKER_PREFIX)) continue;
    const markerId = extractCiDebugMarker(body);
    if (!markerId) continue;
    if (markerId === params.markerId && typeof comment.databaseId === "number") {
      return { commentId: comment.databaseId, reachedMax };
    }
  }
  return { commentId: null, reachedMax };
}

export async function upsertCiDebugComment(params: {
  github: GitHubClient;
  repo: string;
  prNumber: number;
  commentBody: string;
  commentId?: number | null;
  commentScanLimit?: number;
}): Promise<CiDebugWritebackResult> {
  const { owner, name } = splitRepoFullName(params.repo);
  const markerId = extractCiDebugMarker(params.commentBody) ?? buildCiDebugMarkerId({
    repo: params.repo,
    prNumber: params.prNumber,
  });

  let commentId = typeof params.commentId === "number" ? params.commentId : null;
  let markerFound = false;

  if (!commentId) {
    const scanLimit = params.commentScanLimit ?? DEFAULT_COMMENT_SCAN_LIMIT;
    const found = await findExistingCiDebugComment({
      github: params.github,
      repo: params.repo,
      prNumber: params.prNumber,
      markerId,
      scanLimit,
    });
    commentId = found.commentId;
    markerFound = Boolean(found.commentId);
  }

  if (commentId) {
    try {
      await params.github.request(`/repos/${owner}/${name}/issues/comments/${commentId}`, {
        method: "PATCH",
        body: { body: params.commentBody },
      });
      return { commentId, created: false, updated: true, skipped: false, markerFound: true };
    } catch (error: any) {
      if (error?.code !== "not_found") throw error;
      commentId = null;
    }
  }

  const create = await params.github.request<{ id?: number | null }>(
    `/repos/${owner}/${name}/issues/${params.prNumber}/comments`,
    { method: "POST", body: { body: params.commentBody } }
  );
  const createdId = typeof create.data?.id === "number" ? create.data.id : null;

  return {
    commentId: createdId,
    created: true,
    updated: false,
    skipped: false,
    markerFound,
  };
}
