import { splitRepoFullName, type GitHubClient } from "./client";

export type CmdDecision = "applied" | "refused" | "failed";

export type CmdCommentState = {
  version: 1;
  key: string;
  repo: string;
  issueNumber: number;
  cmdLabel: string;
  eventId: string | null;
  decision: CmdDecision;
  reason?: string;
  processedAt: string;
};

export type CmdCommentRecord = {
  id: number;
  body: string;
  updatedAt?: string;
};

export type CmdCommentMatch = {
  markerId: string;
  marker: string;
  comment: CmdCommentRecord | null;
  state: CmdCommentState | null;
};

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

const CMD_MARKER_REGEX = /<!--\s*ralph-cmd:id=([a-z0-9]+)\s*-->/i;
const CMD_STATE_REGEX = /<!--\s*ralph-cmd:state=([^>]+)\s*-->/i;

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildMarkerId(key: string): string {
  const base = `cmd|${key}`;
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildCmdMarker(key: string): { markerId: string; marker: string } {
  const markerId = buildMarkerId(key);
  return { markerId, marker: `<!-- ralph-cmd:id=${markerId} -->` };
}

function serializeState(state: CmdCommentState): string {
  return JSON.stringify(state);
}

function parseCmdCommentState(body: string): CmdCommentState | null {
  const match = body.match(CMD_STATE_REGEX);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as CmdCommentState;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildCmdCommentBody(params: {
  key: string;
  state: CmdCommentState;
  lines: string[];
}): string {
  const { marker } = buildCmdMarker(params.key);
  const stateLine = `<!-- ralph-cmd:state=${serializeState(params.state)} -->`;
  return [marker, stateLine, "", ...params.lines].join("\n");
}

export async function findCmdComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  key: string;
  limit?: number;
}): Promise<CmdCommentMatch> {
  const { owner, name } = splitRepoFullName(params.repo);
  const { markerId, marker } = buildCmdMarker(params.key);
  const limit = Math.min(Math.max(1, params.limit ?? 50), 100);

  const response = await params.github.request<
    Array<{ id?: number | null; body?: string | null; updated_at?: string | null }>
  >(`/repos/${owner}/${name}/issues/${params.issueNumber}/comments?per_page=${limit}&sort=created&direction=desc`);
  const comments = response.data ?? [];

  for (const comment of comments) {
    const body = comment?.body ?? "";
    const match = body.match(CMD_MARKER_REGEX);
    const found = match?.[1] ?? "";
    if (!found) continue;
    if (found.toLowerCase() !== markerId.toLowerCase() && !body.includes(marker)) continue;
    const id = typeof comment?.id === "number" ? comment.id : Number(comment?.id ?? 0);
    if (!id) continue;
    return {
      markerId,
      marker,
      comment: { id, body, updatedAt: comment?.updated_at ?? undefined },
      state: parseCmdCommentState(body),
    };
  }

  return { markerId, marker, comment: null, state: null };
}

export async function createCmdComment(params: {
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

export async function updateCmdComment(params: {
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
