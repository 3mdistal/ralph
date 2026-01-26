import { splitRepoFullName, type GitHubClient } from "./client";

export type CiDebugAttempt = {
  attempt: number;
  signature: string;
  startedAt: string;
  completedAt?: string;
  status?: "running" | "failed" | "succeeded";
  runUrls?: string[];
};

export type CiDebugLease = {
  holder: string;
  expiresAt: string;
};

export type CiDebugCommentState = {
  version: 1;
  lease?: CiDebugLease;
  attempts?: CiDebugAttempt[];
  lastSignature?: string;
};

export type CiDebugCommentRecord = {
  id: number;
  body: string;
  updatedAt?: string;
};

export type CiDebugCommentMatch = {
  markerId: string;
  marker: string;
  comment: CiDebugCommentRecord | null;
  state: CiDebugCommentState | null;
};

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const CI_DEBUG_MARKER_REGEX = /<!--\s*ralph-ci-debug:id=([a-z0-9]+)\s*-->/i;
const CI_DEBUG_STATE_REGEX = /<!--\s*ralph-ci-debug:state=([^>]+)\s*-->/i;

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildMarkerId(params: { repo: string; issueNumber: number }): string {
  const base = `${params.repo}|${params.issueNumber}`;
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildCiDebugMarker(params: { repo: string; issueNumber: number }): { markerId: string; marker: string } {
  const markerId = buildMarkerId(params);
  return { markerId, marker: `<!-- ralph-ci-debug:id=${markerId} -->` };
}

function serializeCiDebugState(state: CiDebugCommentState): string {
  return JSON.stringify(state);
}

export function parseCiDebugState(body: string): CiDebugCommentState | null {
  const match = body.match(CI_DEBUG_STATE_REGEX);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as CiDebugCommentState;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildCiDebugCommentBody(params: {
  marker: string;
  state: CiDebugCommentState;
  lines: string[];
}): string {
  const stateLine = `<!-- ralph-ci-debug:state=${serializeCiDebugState(params.state)} -->`;
  return [params.marker, stateLine, "", ...params.lines].join("\n");
}

export async function findCiDebugComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  limit?: number;
}): Promise<CiDebugCommentMatch> {
  const { owner, name } = splitRepoFullName(params.repo);
  const { markerId, marker } = buildCiDebugMarker({ repo: params.repo, issueNumber: params.issueNumber });
  const limit = Math.min(Math.max(1, params.limit ?? 50), 100);

  const response = await params.github.request<
    Array<{ id?: number | null; body?: string | null; updated_at?: string | null }>
  >(`/repos/${owner}/${name}/issues/${params.issueNumber}/comments?per_page=${limit}&sort=created&direction=desc`);
  const comments = response.data ?? [];

  for (const comment of comments) {
    const body = comment?.body ?? "";
    const match = body.match(CI_DEBUG_MARKER_REGEX);
    const found = match?.[1] ?? "";
    if (!found) continue;
    if (found.toLowerCase() !== markerId.toLowerCase() && !body.includes(marker)) continue;
    const id = typeof comment?.id === "number" ? comment.id : Number(comment?.id ?? 0);
    if (!id) continue;
    return {
      markerId,
      marker,
      comment: {
        id,
        body,
        updatedAt: comment?.updated_at ?? undefined,
      },
      state: parseCiDebugState(body),
    };
  }

  return { markerId, marker, comment: null, state: null };
}

export async function createCiDebugComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/comments`, {
    method: "POST",
    body: { body: params.body },
  });
}

export async function updateCiDebugComment(params: {
  github: GitHubClient;
  repo: string;
  commentId: number;
  body: string;
}): Promise<void> {
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/comments/${params.commentId}`, {
    method: "PATCH",
    body: { body: params.body },
  });
}
