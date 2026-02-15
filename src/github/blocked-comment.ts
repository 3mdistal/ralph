import { deleteIdempotencyKey, getIdempotencyPayload, initStateDb, recordIdempotencyKey, upsertIdempotencyKey } from "../state";
import { parseIssueRef } from "./issue-ref";
import { GitHubApiError, splitRepoFullName, type GitHubClient } from "./client";

export type BlockedCommentState = {
  version: 1;
  kind: "deps";
  blocked: boolean;
  reason: string | null;
  deps: Array<{ repo: string; issueNumber: number }>;
  blockedAt: string | null;
  updatedAt: string;
};

type BlockedCommentRecord = {
  id: number;
  body: string;
  updatedAt?: string;
  htmlUrl?: string;
};

const MARKER_REGEX = /<!--\s*ralph-blocked:v1\s+id=([a-z0-9]+)\s*-->/i;
const STATE_REGEX = /<!--\s*ralph-blocked:state=([^>]+)\s*-->/i;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const DEFAULT_COALESCE_WINDOW_MS = 250;
const BLOCKED_COMMENT_BACKOFF_MIN_MS = 5_000;
const BLOCKED_COMMENT_BACKOFF_MAX_MS = 5 * 60_000;

type BlockedCommentIssueState = {
  inFlightByHash: Map<string, Promise<{ updated: boolean; url: string | null; suppressed?: boolean }>>;
  cooldownUntilMs: number;
  failureCount: number;
};

const blockedCommentStateByIssue = new Map<string, BlockedCommentIssueState>();

function issueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function getIssueState(repo: string, issueNumber: number): BlockedCommentIssueState {
  const key = issueKey(repo, issueNumber);
  const existing = blockedCommentStateByIssue.get(key);
  if (existing) return existing;
  const created: BlockedCommentIssueState = {
    inFlightByHash: new Map(),
    cooldownUntilMs: 0,
    failureCount: 0,
  };
  blockedCommentStateByIssue.set(key, created);
  return created;
}

function readCoalesceWindowMs(): number {
  const raw = Number(process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS ?? DEFAULT_COALESCE_WINDOW_MS);
  if (!Number.isFinite(raw)) return DEFAULT_COALESCE_WINDOW_MS;
  return Math.max(0, Math.floor(raw));
}

function emit(repo: string, type: string, data: Record<string, unknown>): void {
  console.log(`[ralph:telemetry:${repo}] ${type} ${JSON.stringify(data)}`);
}

function isTransientBlockedCommentError(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    if (error.status === 429 || error.code === "rate_limit") return true;
    const text = error.responseText.toLowerCase();
    if (text.includes("secondary rate limit") || text.includes("abuse detection") || text.includes("temporarily blocked")) {
      return true;
    }
    return false;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout") || message.includes("temporarily blocked");
}

function computeBackoffMs(failureCount: number): number {
  const safeFailures = Math.max(1, failureCount);
  const exponential = Math.min(BLOCKED_COMMENT_BACKOFF_MAX_MS, BLOCKED_COMMENT_BACKOFF_MIN_MS * 2 ** (safeFailures - 1));
  const jitter = Math.floor(exponential * Math.random() * 0.2);
  return Math.min(BLOCKED_COMMENT_BACKOFF_MAX_MS, exponential + jitter);
}

export function __resetBlockedCommentWriteStateForTests(): void {
  blockedCommentStateByIssue.clear();
}

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildMarkerId(repo: string, issueNumber: number): string {
  const base = `${repo}|${issueNumber}|blocked`;
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function bodyHash(body: string): string {
  return hashFNV1a(body.replace(/\r\n/g, "\n").trimEnd() + "\n");
}

function parsePayloadBodyHash(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { bodyHash?: unknown };
    return typeof parsed.bodyHash === "string" ? parsed.bodyHash : null;
  } catch {
    return null;
  }
}

export function parseBlockedCommentState(body: string): BlockedCommentState | null {
  const match = body.match(STATE_REGEX);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as BlockedCommentState;
    if (!parsed || parsed.version !== 1 || parsed.kind !== "deps") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function extractDependencyRefs(text: string, baseRepo: string): Array<{ repo: string; issueNumber: number }> {
  const found = new Map<string, { repo: string; issueNumber: number }>();
  const re = /(?:[\w.-]+\/[\w.-]+)?#\d+/g;
  for (const match of text.matchAll(re)) {
    const raw = match[0]?.trim() ?? "";
    if (!raw) continue;
    const ref = parseIssueRef(raw, baseRepo);
    if (!ref) continue;
    found.set(`${ref.repo}#${ref.number}`, { repo: ref.repo, issueNumber: ref.number });
  }
  return [...found.values()];
}

export function buildBlockedCommentBody(params: {
  marker: string;
  state: BlockedCommentState;
  issueNumber: number;
}): string {
  const stateLine = `<!-- ralph-blocked:state=${JSON.stringify(params.state)} -->`;
  const human = params.state.blocked
    ? [
        `Blocked on dependencies for #${params.issueNumber}.`,
        "",
        `Reason: ${params.state.reason ?? "(none)"}`,
        `Blocked at: ${params.state.blockedAt ?? "unknown"}`,
      ]
    : [`Dependencies unblocked for #${params.issueNumber}.`];
  return [params.marker, stateLine, "", ...human].join("\n");
}

async function findBlockedComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  markerId: string;
  marker: string;
  limit?: number;
}): Promise<BlockedCommentRecord | null> {
  const { owner, name } = splitRepoFullName(params.repo);
  const limit = Math.min(Math.max(1, params.limit ?? 50), 100);
  const response = await params.github.request<Array<{ id?: number | null; body?: string | null; updated_at?: string | null; html_url?: string | null }>>(
    `/repos/${owner}/${name}/issues/${params.issueNumber}/comments?per_page=${limit}&sort=created&direction=desc`
  );
  for (const comment of response.data ?? []) {
    const body = comment?.body ?? "";
    const match = body.match(MARKER_REGEX);
    const marker = match?.[1] ?? "";
    if (marker.toLowerCase() !== params.markerId.toLowerCase() && !body.includes(params.marker)) continue;
    const id = typeof comment?.id === "number" ? comment.id : Number(comment?.id ?? 0);
    if (!id) continue;
    return {
      id,
      body,
      updatedAt: comment?.updated_at ?? undefined,
      htmlUrl: comment?.html_url ?? undefined,
    };
  }
  return null;
}

export async function upsertBlockedComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  state: BlockedCommentState;
  limit?: number;
}): Promise<{ updated: boolean; url: string | null }> {
  const issueState = getIssueState(params.repo, params.issueNumber);
  const markerId = buildMarkerId(params.repo, params.issueNumber);
  const marker = `<!-- ralph-blocked:v1 id=${markerId} -->`;
  const body = buildBlockedCommentBody({ marker, state: params.state, issueNumber: params.issueNumber });
  const expectedHash = bodyHash(body);

  if (issueState.cooldownUntilMs > Date.now()) {
    emit(params.repo, "github.write.suppressed", {
      kind: "blocked-comment",
      repo: params.repo,
      issueNumber: params.issueNumber,
      reason: "cooldown",
      cooldownUntilMs: issueState.cooldownUntilMs,
    });
    return { updated: false, url: null };
  }

  const existingInflight = issueState.inFlightByHash.get(expectedHash);
  if (existingInflight) {
    emit(params.repo, "github.write.coalesced", {
      kind: "blocked-comment",
      repo: params.repo,
      issueNumber: params.issueNumber,
      reason: "identical",
    });
    return await existingInflight;
  }

  const run = async () => {
    const windowMs = readCoalesceWindowMs();
    if (windowMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, windowMs));
    }
    return await upsertBlockedCommentNow(params, { body, expectedHash, marker, markerId });
  };

  const inflight = run()
    .then((result) => {
      issueState.failureCount = 0;
      issueState.cooldownUntilMs = 0;
      return result;
    })
    .catch((error) => {
      if (isTransientBlockedCommentError(error)) {
        issueState.failureCount += 1;
        const backoffMs = computeBackoffMs(issueState.failureCount);
        issueState.cooldownUntilMs = Date.now() + backoffMs;
      }
      throw error;
    })
    .finally(() => {
      issueState.inFlightByHash.delete(expectedHash);
    });
  issueState.inFlightByHash.set(expectedHash, inflight);
  return await inflight;
}

async function upsertBlockedCommentNow(
  params: {
    github: GitHubClient;
    repo: string;
    issueNumber: number;
    state: BlockedCommentState;
    limit?: number;
  },
  precomputed?: { body: string; expectedHash: string; marker: string; markerId: string }
): Promise<{ updated: boolean; url: string | null }> {
  initStateDb();
  const markerId = precomputed?.markerId ?? buildMarkerId(params.repo, params.issueNumber);
  const marker = precomputed?.marker ?? `<!-- ralph-blocked:v1 id=${markerId} -->`;
  const body = precomputed?.body ?? buildBlockedCommentBody({ marker, state: params.state, issueNumber: params.issueNumber });
  const expectedHash = precomputed?.expectedHash ?? bodyHash(body);
  const idempotencyKey = `gh-blocked-comment:${params.repo}#${params.issueNumber}:${markerId}`;
  const priorHash = parsePayloadBodyHash(getIdempotencyPayload(idempotencyKey));

  const existing = await findBlockedComment({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    markerId,
    marker,
    limit: params.limit,
  });

  if (existing) {
    if (bodyHash(existing.body) === expectedHash) {
      emit(params.repo, "github.write.dropped", {
        kind: "blocked-comment",
        repo: params.repo,
        issueNumber: params.issueNumber,
        reason: "identical",
      });
      upsertIdempotencyKey({ key: idempotencyKey, scope: "gh-blocked-comment", payloadJson: JSON.stringify({ bodyHash: expectedHash }) });
      return { updated: false, url: existing.htmlUrl ?? null };
    }
    const { owner, name } = splitRepoFullName(params.repo);
    const updated = await params.github.request<{ html_url?: string | null }>(
      `/repos/${owner}/${name}/issues/comments/${existing.id}`,
      { method: "PATCH", body: { body } }
    );
    upsertIdempotencyKey({ key: idempotencyKey, scope: "gh-blocked-comment", payloadJson: JSON.stringify({ bodyHash: expectedHash }) });
    return { updated: true, url: updated.data?.html_url ?? existing.htmlUrl ?? null };
  }

  const claimed = recordIdempotencyKey({ key: idempotencyKey, scope: "gh-blocked-comment", payloadJson: JSON.stringify({ bodyHash: expectedHash }) });
  if (!claimed && priorHash === expectedHash) {
    emit(params.repo, "github.write.dropped", {
      kind: "blocked-comment",
      repo: params.repo,
      issueNumber: params.issueNumber,
      reason: "idempotent",
    });
    return { updated: false, url: null };
  }

  try {
    const { owner, name } = splitRepoFullName(params.repo);
    const created = await params.github.request<{ html_url?: string | null }>(
      `/repos/${owner}/${name}/issues/${params.issueNumber}/comments`,
      { method: "POST", body: { body } }
    );
    upsertIdempotencyKey({ key: idempotencyKey, scope: "gh-blocked-comment", payloadJson: JSON.stringify({ bodyHash: expectedHash }) });
    return { updated: true, url: created.data?.html_url ?? null };
  } catch (error) {
    deleteIdempotencyKey(idempotencyKey);
    throw error;
  }
}
