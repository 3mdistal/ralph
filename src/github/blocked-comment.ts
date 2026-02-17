import { deleteIdempotencyKey, getIdempotencyPayload, initStateDb, recordIdempotencyKey, upsertIdempotencyKey } from "../state";
import { parseIssueRef } from "./issue-ref";
import { GitHubApiError, splitRepoFullName, type GitHubClient } from "./client";
import { shouldLog } from "../logging";
import { publishDashboardEvent } from "../dashboard/publisher";

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
const DEFAULT_BLOCKED_COMMENT_COALESCE_MS = 500;
const BLOCKED_COMMENT_COOLDOWN_BASE_MS = 5_000;
const BLOCKED_COMMENT_COOLDOWN_MAX_MS = 5 * 60_000;

type BlockedCommentWriteClass = "critical" | "important" | "best-effort";
type PendingBlockedComment = {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  state: BlockedCommentState;
  limit?: number;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Array<{ resolve: (value: { updated: boolean; url: string | null }) => void; reject: (error: unknown) => void }>;
};

const pendingBlockedComments = new Map<string, PendingBlockedComment>();
const blockedCommentCooldownByIssue = new Map<string, { untilMs: number; failures: number }>();

export function __resetBlockedCommentWriteStateForTests(): void {
  pendingBlockedComments.clear();
  blockedCommentCooldownByIssue.clear();
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

function readBlockedCommentCoalesceWindowMs(): number {
  const raw = process.env.RALPH_GITHUB_BLOCKED_COMMENT_COALESCE_MS;
  if (raw === undefined) return DEFAULT_BLOCKED_COMMENT_COALESCE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_BLOCKED_COMMENT_COALESCE_MS;
  return Math.max(0, Math.floor(parsed));
}

function nextBlockedCommentCooldownMs(failures: number): number {
  const exp = Math.max(0, Math.min(12, failures));
  return Math.min(BLOCKED_COMMENT_COOLDOWN_MAX_MS, BLOCKED_COMMENT_COOLDOWN_BASE_MS * 2 ** exp);
}

function semanticBlockedState(state: BlockedCommentState): Omit<BlockedCommentState, "updatedAt"> {
  return {
    version: state.version,
    kind: state.kind,
    blocked: state.blocked,
    reason: state.reason,
    deps: state.deps,
    blockedAt: state.blockedAt,
  };
}

function semanticStateHash(state: BlockedCommentState): string {
  return hashFNV1a(JSON.stringify(semanticBlockedState(state)));
}

function emitBlockedCommentTelemetry(params: {
  repo: string;
  issueNumber: number;
  source: "coalesced" | "dropped-noop" | "suppressed-cooldown";
  reason: string;
  detail?: string;
}): void {
  const issueKey = `${params.repo}#${params.issueNumber}`;
  if (!shouldLog(`blocked-comment:${params.source}:${issueKey}`, 10_000)) return;
  const message = `[ralph:github:blocked-comment] ${issueKey} ${params.source} reason=${params.reason}${
    params.detail ? ` detail=${params.detail}` : ""
  }`;
  console.warn(message);
  publishDashboardEvent(
    {
      type: "log.ralph",
      level: "debug",
      data: { message },
    },
    { repo: params.repo }
  );
}

function isTransientBlockedCommentError(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    if (error.status === 429) return true;
    if (error.status === 403 && /secondary rate limit|abuse detection|temporarily blocked/i.test(error.responseText)) return true;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /timed out|timeout|abort|rate limit|temporarily blocked/i.test(message);
}

function maybeBlockedCommentRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof GitHubApiError)) return null;
  if (typeof error.resumeAtTs !== "number" || !Number.isFinite(error.resumeAtTs)) return null;
  const ms = Math.floor(error.resumeAtTs - Date.now());
  return ms > 0 ? ms : null;
}

function parsePayloadBodyHash(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { bodyHash?: unknown; semanticHash?: unknown };
    if (typeof parsed.semanticHash === "string") return parsed.semanticHash;
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
  const responseResult = await requestBestEffort<Array<{ id?: number | null; body?: string | null; updated_at?: string | null; html_url?: string | null }>>(
    params.github,
    `/repos/${owner}/${name}/issues/${params.issueNumber}/comments?per_page=${limit}&sort=created&direction=desc`,
    { source: "blocked-comment:find" }
  );
  if (!responseResult.ok) {
    if ("deferred" in responseResult) return null;
    throw responseResult.error;
  }
  const response = responseResult.response;
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

async function requestBestEffort<T>(
  github: GitHubClient,
  path: string,
  opts?: { method?: string; body?: unknown; source?: string }
): Promise<{ ok: true; response: { data: T | null; status: number } } | { ok: false; deferred: true } | { ok: false; error: unknown }> {
  const withLane = (github as any).requestWithLane;
  if (typeof withLane === "function") {
    const result = await withLane.call(github, path, {
      method: opts?.method,
      body: opts?.body,
      lane: "best_effort",
      source: opts?.source,
    });
    if (!result.ok) {
      if ("deferred" in result) return { ok: false, deferred: true };
      return { ok: false, error: result.error };
    }
    return { ok: true, response: result.response };
  }

  try {
    const fallback = await github.request<T>(path, {
      method: opts?.method,
      body: opts?.body,
      source: opts?.source,
    });
    return { ok: true, response: fallback };
  } catch (error) {
    return { ok: false, error };
  }
}

async function upsertBlockedCommentNow(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  state: BlockedCommentState;
  limit?: number;
  writeClass?: BlockedCommentWriteClass;
}): Promise<{ updated: boolean; url: string | null }> {
  initStateDb();
  const markerId = buildMarkerId(params.repo, params.issueNumber);
  const marker = `<!-- ralph-blocked:v1 id=${markerId} -->`;
  const body = buildBlockedCommentBody({ marker, state: params.state, issueNumber: params.issueNumber });
  const expectedHash = semanticStateHash(params.state);
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
    const existingState = parseBlockedCommentState(existing.body);
    if (existingState && semanticStateHash(existingState) === expectedHash) {
      upsertIdempotencyKey({
        key: idempotencyKey,
        scope: "gh-blocked-comment",
        payloadJson: JSON.stringify({ semanticHash: expectedHash }),
      });
      return { updated: false, url: existing.htmlUrl ?? null };
    }
    const { owner, name } = splitRepoFullName(params.repo);
    const updatedResult = await requestBestEffort<{ html_url?: string | null }>(
      params.github,
      `/repos/${owner}/${name}/issues/comments/${existing.id}`,
      { method: "PATCH", body: { body }, source: "blocked-comment:patch" }
    );
    if (!updatedResult.ok) {
      if ("deferred" in updatedResult) return { updated: false, url: existing.htmlUrl ?? null };
      throw updatedResult.error;
    }
    const updated = updatedResult.response;
    upsertIdempotencyKey({ key: idempotencyKey, scope: "gh-blocked-comment", payloadJson: JSON.stringify({ semanticHash: expectedHash }) });
    return { updated: true, url: updated.data?.html_url ?? existing.htmlUrl ?? null };
  }

  const claimed = recordIdempotencyKey({
    key: idempotencyKey,
    scope: "gh-blocked-comment",
    payloadJson: JSON.stringify({ semanticHash: expectedHash }),
  });
  if (!claimed && priorHash === expectedHash) {
    return { updated: false, url: null };
  }

  try {
    const { owner, name } = splitRepoFullName(params.repo);
    const createdResult = await requestBestEffort<{ html_url?: string | null }>(
      params.github,
      `/repos/${owner}/${name}/issues/${params.issueNumber}/comments`,
      { method: "POST", body: { body }, source: "blocked-comment:create" }
    );
    if (!createdResult.ok) {
      if ("deferred" in createdResult) return { updated: false, url: null };
      throw createdResult.error;
    }
    const created = createdResult.response;
    upsertIdempotencyKey({ key: idempotencyKey, scope: "gh-blocked-comment", payloadJson: JSON.stringify({ semanticHash: expectedHash }) });
    return { updated: true, url: created.data?.html_url ?? null };
  } catch (error) {
    deleteIdempotencyKey(idempotencyKey);
    throw error;
  }
}

export async function upsertBlockedComment(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  state: BlockedCommentState;
  limit?: number;
  writeClass?: BlockedCommentWriteClass;
}): Promise<{ updated: boolean; url: string | null }> {
  const writeClass = params.writeClass ?? "important";
  const issueKey = `${params.repo}#${params.issueNumber}`;
  const cooldown = blockedCommentCooldownByIssue.get(issueKey);
  if (cooldown && cooldown.untilMs > Date.now()) {
    emitBlockedCommentTelemetry({
      repo: params.repo,
      issueNumber: params.issueNumber,
      source: "suppressed-cooldown",
      reason: "cooldown-active",
      detail: `until=${new Date(cooldown.untilMs).toISOString()}`,
    });
    return { updated: false, url: null };
  }
  if (cooldown && cooldown.untilMs <= Date.now()) {
    blockedCommentCooldownByIssue.delete(issueKey);
  }

  const windowMs = readBlockedCommentCoalesceWindowMs();
  if (writeClass !== "best-effort" || windowMs <= 0) {
    try {
      const result = await upsertBlockedCommentNow(params);
      blockedCommentCooldownByIssue.delete(issueKey);
      return result;
    } catch (error) {
      if (isTransientBlockedCommentError(error)) {
        const existing = blockedCommentCooldownByIssue.get(issueKey) ?? { untilMs: 0, failures: 0 };
        const retryAfterMs = maybeBlockedCommentRetryAfterMs(error);
        const backoffMs = retryAfterMs ?? nextBlockedCommentCooldownMs(existing.failures);
        const untilMs = Date.now() + backoffMs;
        blockedCommentCooldownByIssue.set(issueKey, { untilMs, failures: existing.failures + 1 });
      }
      throw error;
    }
  }

  let pending = pendingBlockedComments.get(issueKey);
  if (!pending) {
    pending = {
      github: params.github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      state: params.state,
      limit: params.limit,
      timer: null,
      waiters: [],
    };
    pendingBlockedComments.set(issueKey, pending);
  } else {
    emitBlockedCommentTelemetry({
      repo: params.repo,
      issueNumber: params.issueNumber,
      source: "coalesced",
      reason: "merged-into-pending-window",
    });
  }
  pending.state = params.state;
  pending.github = params.github;
  pending.limit = params.limit;
  if (pending.timer) clearTimeout(pending.timer);

  return await new Promise<{ updated: boolean; url: string | null }>((resolve, reject) => {
    pending!.waiters.push({ resolve, reject });
    pending!.timer = setTimeout(async () => {
      const current = pendingBlockedComments.get(issueKey);
      if (!current) return;
      pendingBlockedComments.delete(issueKey);
      current.timer = null;
      const waiters = current.waiters.splice(0, current.waiters.length);
      try {
        const result = await upsertBlockedCommentNow({
          github: current.github,
          repo: current.repo,
          issueNumber: current.issueNumber,
          state: current.state,
          limit: current.limit,
          writeClass,
        });
        blockedCommentCooldownByIssue.delete(issueKey);
        if (!result.updated) {
          emitBlockedCommentTelemetry({
            repo: current.repo,
            issueNumber: current.issueNumber,
            source: "dropped-noop",
            reason: "semantic-noop",
          });
        }
        for (const waiter of waiters) waiter.resolve(result);
      } catch (error) {
        if (isTransientBlockedCommentError(error)) {
          const existing = blockedCommentCooldownByIssue.get(issueKey) ?? { untilMs: 0, failures: 0 };
          const retryAfterMs = maybeBlockedCommentRetryAfterMs(error);
          const backoffMs = retryAfterMs ?? nextBlockedCommentCooldownMs(existing.failures);
          const untilMs = Date.now() + backoffMs;
          blockedCommentCooldownByIssue.set(issueKey, { untilMs, failures: existing.failures + 1 });
          emitBlockedCommentTelemetry({
            repo: current.repo,
            issueNumber: current.issueNumber,
            source: "suppressed-cooldown",
            reason: "transient-write-failure",
            detail: `until=${new Date(untilMs).toISOString()}`,
          });
        }
        for (const waiter of waiters) waiter.reject(error);
      }
    }, windowMs);
  });
}
