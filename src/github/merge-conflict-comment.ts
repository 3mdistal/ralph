import { splitRepoFullName, type GitHubClient } from "./client";

export type MergeConflictAttempt = {
  attempt: number;
  signature: string;
  startedAt: string;
  completedAt?: string;
  status?: "running" | "failed" | "succeeded";
  failureClass?: "merge-content" | "permission" | "tooling" | "runtime";
  conflictCount?: number;
  conflictPaths?: string[];
};

export type MergeConflictLease = {
  holder: string;
  expiresAt: string;
};

export type MergeConflictCommentState = {
  version: 1;
  lease?: MergeConflictLease;
  attempts?: MergeConflictAttempt[];
  lastSignature?: string;
};

export type MergeConflictCommentRecord = {
  id: number;
  body: string;
  updatedAt?: string;
};

export type MergeConflictCommentMatch = {
  markerId: string;
  marker: string;
  comment: MergeConflictCommentRecord | null;
  state: MergeConflictCommentState | null;
};

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const MERGE_CONFLICT_MARKER_REGEX = /<!--\s*ralph-merge-conflict:id=([a-z0-9]+)\s*-->/i;
const MERGE_CONFLICT_STATE_REGEX = /<!--\s*ralph-merge-conflict:state=([^>]+)\s*-->/i;

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

function buildMergeConflictMarker(params: { repo: string; issueNumber: number }): { markerId: string; marker: string } {
  const markerId = buildMarkerId(params);
  return { markerId, marker: `<!-- ralph-merge-conflict:id=${markerId} -->` };
}

function serializeMergeConflictState(state: MergeConflictCommentState): string {
  return JSON.stringify(state);
}

export function parseMergeConflictState(body: string): MergeConflictCommentState | null {
  const match = body.match(MERGE_CONFLICT_STATE_REGEX);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as MergeConflictCommentState;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildMergeConflictCommentBody(params: {
  marker: string;
  state: MergeConflictCommentState;
  lines: string[];
}): string {
  const stateLine = `<!-- ralph-merge-conflict:state=${serializeMergeConflictState(params.state)} -->`;
  return [params.marker, stateLine, "", ...params.lines].join("\n");
}

export async function findMergeConflictComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  limit?: number;
}): Promise<MergeConflictCommentMatch> {
  const { owner, name } = splitRepoFullName(params.repo);
  const { markerId, marker } = buildMergeConflictMarker({ repo: params.repo, issueNumber: params.issueNumber });
  const limit = Math.min(Math.max(1, params.limit ?? 50), 100);

  const response = await params.github.request<
    Array<{ id?: number | null; body?: string | null; updated_at?: string | null }>
  >(`/repos/${owner}/${name}/issues/${params.issueNumber}/comments?per_page=${limit}&sort=created&direction=desc`);
  const comments = response.data ?? [];

  for (const comment of comments) {
    const body = comment?.body ?? "";
    const match = body.match(MERGE_CONFLICT_MARKER_REGEX);
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
      state: parseMergeConflictState(body),
    };
  }

  return { markerId, marker, comment: null, state: null };
}

export async function createMergeConflictComment(params: {
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

export async function updateMergeConflictComment(params: {
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
