import { open } from "fs/promises";
import { existsSync } from "fs";

import { splitRepoFullName, type GitHubClient } from "./client";
import { executeIssueLabelOps } from "./issue-label-io";
import { getSessionEventsPath } from "../paths";
import { isSafeSessionId } from "../session-id";
import { initStateDb, hasIdempotencyKey, recordIdempotencyKey, deleteIdempotencyKey } from "../state";
import { sanitizeEscalationReason } from "./escalation-writeback";

export type WatchdogWritebackKind = "stuck" | "escalated";

export type WatchdogWritebackContext = {
  repo: string;
  issueNumber: number;
  taskName: string;
  taskPath: string;
  sessionId?: string | null;
  worktreePath?: string | null;
  stage?: string | null;
  watchdogTimeout?: {
    toolName: string;
    callId: string;
    elapsedMs: number;
    softMs: number;
    hardMs: number;
    lastProgressMsAgo: number;
    argsPreview?: string;
    source?: string;
    context?: string;
    recentEvents?: string[];
  } | null;
  output?: string | null;
  kind: WatchdogWritebackKind;
  suggestedCommands?: string[];
};

export type WatchdogWritebackPlan = {
  marker: string;
  markerId: string;
  commentBody: string;
  addLabels: string[];
  removeLabels: string[];
  idempotencyKey: string;
};

export type WatchdogWritebackResult = {
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

const WATCHDOG_MARKER_PREFIX = "<!-- ralph-watchdog:id=";
const WATCHDOG_MARKER_REGEX = /<!--\s*ralph-watchdog:id=([a-f0-9]+)\s*-->/i;
const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const MAX_LINE_CHARS = 400;
const MAX_SNIPPET_CHARS = 1200;
const MAX_COMMENT_CHARS = 60000;
const MAX_EVENT_LINES = 24;
const MAX_EVENTS_BYTES = 64 * 1024;
const MAX_EVENTS_TAIL_LINES = 250;

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

function buildMarkerId(params: { repo: string; issueNumber: number; kind: WatchdogWritebackKind; sessionId?: string | null }): string {
  const base = [params.repo, params.issueNumber, params.kind, params.sessionId || "none"].join("|");
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildMarker(params: { repo: string; issueNumber: number; kind: WatchdogWritebackKind; sessionId?: string | null }): string {
  const markerId = buildMarkerId(params);
  return `${WATCHDOG_MARKER_PREFIX}${markerId} -->`;
}

export function extractExistingWatchdogMarker(body: string): string | null {
  const match = body.match(WATCHDOG_MARKER_REGEX);
  return match?.[1] ?? null;
}

async function readTailText(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    const size = Number(stat.size);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

function tailLines(text: string, maxLines: number): string[] {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxLines) return lines;
  return lines.slice(lines.length - maxLines);
}

function safeJson(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function formatEventLine(event: any, fallback: string): string {
  if (!event || typeof event !== "object") return fallback;
  const type = String(event.type ?? "event");

  if (type === "tool-start") {
    const tool = String(event.toolName ?? "unknown");
    const callId = String(event.callId ?? "unknown");
    const args = typeof event.argsPreview === "string" && event.argsPreview ? ` args=${event.argsPreview}` : "";
    return `tool-start ${tool} ${callId}${args}`;
  }
  if (type === "tool-end") {
    const tool = String(event.toolName ?? "unknown");
    const callId = String(event.callId ?? "unknown");
    return `tool-end ${tool} ${callId}`;
  }
  if (type === "step-start") {
    const step = event.step != null ? String(event.step) : "?";
    const title = typeof event.title === "string" && event.title ? ` ${event.title}` : "";
    return `step-start ${step}${title}`;
  }
  if (type === "run-start") {
    const step = event.step != null ? String(event.step) : "";
    const title = typeof event.stepTitle === "string" && event.stepTitle ? ` ${event.stepTitle}` : "";
    return `run-start${step ? ` step=${step}` : ""}${title}`;
  }
  if (type === "run-end") {
    const success = event.success === true ? "success" : "failure";
    const code = event.exitCode != null ? ` exit=${event.exitCode}` : "";
    return `run-end ${success}${code}`;
  }
  if (type === "anomaly") {
    return "anomaly detected";
  }

  return fallback;
}

async function readRecentSessionEvents(sessionId: string): Promise<{ lines: string[]; anomalySnippet?: string | null }> {
  if (!isSafeSessionId(sessionId)) return { lines: [] };
  const path = getSessionEventsPath(sessionId);
  if (!existsSync(path)) return { lines: [] };

  let text: string;
  try {
    text = await readTailText(path, MAX_EVENTS_BYTES);
  } catch {
    return { lines: [] };
  }

  const rawLines = tailLines(text, MAX_EVENTS_TAIL_LINES);
  const formatted: string[] = [];
  let anomalySnippet: string | null = null;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = safeJson(trimmed);
    const formattedLine = formatEventLine(event, trimmed);
    const sanitizedLine = truncateText(sanitizeEscalationReason(formattedLine), MAX_LINE_CHARS);
    formatted.push(sanitizedLine);

    if (event && typeof event === "object") {
      const type = String(event.type ?? "");
      if (type === "anomaly" || type === "error") {
        anomalySnippet = truncateText(sanitizeEscalationReason(trimmed), MAX_SNIPPET_CHARS);
      }
    }
  }

  if (formatted.length > MAX_EVENT_LINES) {
    return { lines: formatted.slice(formatted.length - MAX_EVENT_LINES), anomalySnippet };
  }
  return { lines: formatted, anomalySnippet };
}

function extractSnippetFromLines(lines: string[]): string | null {
  const candidates = lines.filter((line) => /anomaly|error|exception/i.test(line));
  if (candidates.length === 0) return null;
  return truncateText(sanitizeEscalationReason(candidates[candidates.length - 1]), MAX_SNIPPET_CHARS);
}

function buildSuggestedCommands(commands?: string[]): string[] {
  const fallback = ["bun test", "bun run typecheck", "bun run build"];
  const trimmed = (commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
  return trimmed.length > 0 ? trimmed : fallback;
}

function buildTimeoutDetails(timeout?: WatchdogWritebackContext["watchdogTimeout"]): string[] {
  if (!timeout) return [];
  const lines: string[] = [];
  lines.push(`Tool: ${timeout.toolName} ${timeout.callId}`);
  lines.push(`Elapsed: ${Math.round(timeout.elapsedMs / 1000)}s`);
  lines.push(`Soft threshold: ${Math.round(timeout.softMs / 1000)}s`);
  lines.push(`Hard threshold: ${Math.round(timeout.hardMs / 1000)}s`);
  lines.push(`Last progress: ${Math.round(timeout.lastProgressMsAgo / 1000)}s ago`);
  if (timeout.argsPreview) lines.push(`Args preview: ${timeout.argsPreview}`);
  if (timeout.context) lines.push(`Context: ${timeout.context}`);
  if (timeout.source) lines.push(`Source: ${timeout.source}`);
  return lines.map((line) => truncateText(sanitizeEscalationReason(line), MAX_LINE_CHARS));
}

export async function buildWatchdogDiagnostics(ctx: WatchdogWritebackContext): Promise<string> {
  const sessionId = ctx.sessionId?.trim() || "(unknown)";
  const worktreePath = ctx.worktreePath?.trim() || "(unknown)";
  const stage = ctx.stage?.trim() || "(unknown)";

  const timeoutDetails = buildTimeoutDetails(ctx.watchdogTimeout ?? undefined);

  let eventLines: string[] = [];
  let anomalySnippet: string | null = null;
  if (ctx.sessionId) {
    const events = await readRecentSessionEvents(ctx.sessionId);
    eventLines = events.lines;
    anomalySnippet = events.anomalySnippet ?? null;
  }

  if (eventLines.length === 0 && ctx.watchdogTimeout?.recentEvents?.length) {
    eventLines = ctx.watchdogTimeout.recentEvents.map((line) =>
      truncateText(sanitizeEscalationReason(line), MAX_LINE_CHARS)
    );
    if (eventLines.length > MAX_EVENT_LINES) {
      eventLines = eventLines.slice(eventLines.length - MAX_EVENT_LINES);
    }
  }

  const fallbackSnippet = extractSnippetFromLines(eventLines);
  const snippet = anomalySnippet ?? fallbackSnippet;

  const suggestedCommands = buildSuggestedCommands(ctx.suggestedCommands);

  const sections: string[] = [];
  sections.push(`Session: ${truncateText(sanitizeEscalationReason(sessionId), MAX_LINE_CHARS)}`);
  sections.push(`Worktree: ${truncateText(sanitizeEscalationReason(worktreePath), MAX_LINE_CHARS)}`);
  sections.push(`Stage: ${truncateText(sanitizeEscalationReason(stage), MAX_LINE_CHARS)}`);

  if (timeoutDetails.length > 0) {
    sections.push("", "Timeout details:", ...timeoutDetails.map((line) => `- ${line}`));
  }

  if (eventLines.length > 0) {
    sections.push("", "Recent OpenCode events (bounded):", ...eventLines.map((line) => `- ${line}`));
  }

  if (snippet) {
    sections.push("", "Last error/anomaly snippet:", snippet);
  }

  if (suggestedCommands.length > 0) {
    sections.push("", "Suggested deterministic commands:", ...suggestedCommands.map((cmd) => `- ${cmd}`));
  }

  const diagnostics = sections.filter(Boolean).join("\n");
  return truncateText(diagnostics, MAX_COMMENT_CHARS);
}

export async function planWatchdogWriteback(ctx: WatchdogWritebackContext): Promise<WatchdogWritebackPlan> {
  const marker = buildMarker({ repo: ctx.repo, issueNumber: ctx.issueNumber, kind: ctx.kind, sessionId: ctx.sessionId });
  const markerId = buildMarkerId({ repo: ctx.repo, issueNumber: ctx.issueNumber, kind: ctx.kind, sessionId: ctx.sessionId });

  const headline =
    ctx.kind === "stuck"
      ? "Ralph hit a watchdog timeout and will retry once with a fresh session."
      : "Ralph hit a watchdog timeout again and escalated the task.";

  const diagnostics = await buildWatchdogDiagnostics(ctx);
  let commentBody = [marker, headline, "", diagnostics].filter(Boolean).join("\n");
  commentBody = truncateText(commentBody, MAX_COMMENT_CHARS);

  return {
    marker,
    markerId,
    commentBody,
    addLabels: ["ralph:status:stuck"],
    removeLabels: [],
    idempotencyKey: `gh-watchdog:${ctx.repo}#${ctx.issueNumber}:${markerId}`,
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

async function addWatchdogLabel(params: { github: GitHubClient; repo: string; issueNumber: number; label: string }) {
  await executeIssueLabelOps({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    ops: [{ action: "add", label: params.label }],
    logLabel: `${params.repo}#${params.issueNumber}`,
    log: (message) => console.warn(`[ralph:gh-watchdog:${params.repo}] ${message}`),
    ensureBefore: true,
  });
}

async function removeWatchdogLabel(params: { github: GitHubClient; repo: string; issueNumber: number; label: string }) {
  await executeIssueLabelOps({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    ops: [{ action: "remove", label: params.label }],
    logLabel: `${params.repo}#${params.issueNumber}`,
    log: (message) => console.warn(`[ralph:gh-watchdog:${params.repo}] ${message}`),
    ensureBefore: true,
  });
}

export async function writeWatchdogToGitHub(
  ctx: WatchdogWritebackContext,
  deps: WritebackDeps
): Promise<WatchdogWritebackResult> {
  const overrideCount = [deps.hasIdempotencyKey, deps.recordIdempotencyKey, deps.deleteIdempotencyKey].filter(
    Boolean
  ).length;
  if (overrideCount > 0 && overrideCount < 3) {
    throw new Error("writeWatchdogToGitHub requires all idempotency overrides when any are provided");
  }
  if (overrideCount === 0) {
    initStateDb();
  }

  const plan = await planWatchdogWriteback(ctx);
  const log = deps.log ?? console.log;
  const commentLimit = Math.min(Math.max(1, deps.commentScanLimit ?? DEFAULT_COMMENT_SCAN_LIMIT), 100);
  const hasKey = deps.hasIdempotencyKey ?? hasIdempotencyKey;
  const recordKey = deps.recordIdempotencyKey ?? recordIdempotencyKey;
  const deleteKey = deps.deleteIdempotencyKey ?? deleteIdempotencyKey;
  const prefix = `[ralph:gh-watchdog:${ctx.repo}]`;

  for (const label of plan.removeLabels) {
    try {
      await removeWatchdogLabel({ github: deps.github, repo: ctx.repo, issueNumber: ctx.issueNumber, label });
    } catch (error: any) {
      log(`${prefix} Failed to remove label '${label}' on #${ctx.issueNumber}: ${error?.message ?? String(error)}`);
    }
  }

  for (const label of plan.addLabels) {
    try {
      await addWatchdogLabel({ github: deps.github, repo: ctx.repo, issueNumber: ctx.issueNumber, label });
    } catch (error: any) {
      log(`${prefix} Failed to add label '${label}' on #${ctx.issueNumber}: ${error?.message ?? String(error)}`);
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

  const markerId = plan.markerId.toLowerCase();
  const markerFound =
    listResult?.comments.some((comment) => {
      const body = comment.body ?? "";
      const found = extractExistingWatchdogMarker(body);
      return found ? found.toLowerCase() === markerId : body.includes(plan.marker);
    }) ?? false;

  if (hasKeyResult && markerFound) {
    log(`${prefix} Watchdog comment already recorded (idempotency + marker); skipping.`);
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
      recordKey({ key: plan.idempotencyKey, scope: "gh-watchdog" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after marker match: ${error?.message ?? String(error)}`);
    }
    log(`${prefix} Existing watchdog marker found for #${ctx.issueNumber}; skipping comment.`);
    return { postedComment: false, skippedComment: true, markerFound: true, commentUrl: null };
  }

  let claimed = false;
  try {
    claimed = recordKey({ key: plan.idempotencyKey, scope: "gh-watchdog" });
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
      log(`${prefix} Watchdog comment already claimed; skipping comment.`);
      return { postedComment: false, skippedComment: true, markerFound: false, commentUrl: null };
    }
  }

  let commentUrl: string | null = null;
  try {
    const comment = await createIssueComment({
      github: deps.github,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
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
      recordKey({ key: plan.idempotencyKey, scope: "gh-watchdog" });
    } catch (error: any) {
      log(`${prefix} Failed to record idempotency after posting comment: ${error?.message ?? String(error)}`);
    }
  }

  log(`${prefix} Posted watchdog comment for #${ctx.issueNumber}.`);
  return { postedComment: true, skippedComment: false, markerFound: false, commentUrl };
}
