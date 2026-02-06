import { GitHubClient, splitRepoFullName } from "./client";
import { initStateDb, hasIdempotencyKey, recordIdempotencyKey, deleteIdempotencyKey } from "../state";
import { executeIssueLabelOps, planIssueLabelOps } from "./issue-label-io";
import { RALPH_LABEL_STATUS_DONE } from "../github-labels";
import type { ParentVerificationConfidence, ParentVerificationEvidence } from "../parent-verification";

export type ParentVerificationCommentPayload = {
  confidence: ParentVerificationConfidence;
  checked: string[];
  whySatisfied: string;
  evidence: ParentVerificationEvidence[];
};

export type ParentVerificationContext = {
  repo: string;
  issueNumber: number;
  payload: ParentVerificationCommentPayload;
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

type IssueComment = {
  body?: string | null;
  databaseId?: number | null;
  url?: string | null;
  createdAt?: string | null;
};

const MARKER_PREFIX = "<!-- ralph-verify:v1 id=";
const MARKER_REGEX = /<!--\s*ralph-verify:v1\s+id=([^\s]+)\s*-->/i;
const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const LABELS_TO_REMOVE = [
  "ralph:status:queued",
  "ralph:status:in-progress",
  "ralph:status:paused",
  "ralph:status:escalated",
  "ralph:status:in-bot",
  "ralph:status:stopped",
];

const MAX_CHECKED_ITEMS = 20;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_TEXT_LENGTH = 300;

function trimText(value: unknown, maxLen = MAX_TEXT_LENGTH): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd();
}

export function buildMarker(params: { issueNumber: number }): string {
  return `${MARKER_PREFIX}${params.issueNumber} -->`;
}

function extractExistingMarker(body: string): string | null {
  const match = body.match(MARKER_REGEX);
  return match?.[1] ?? null;
}

function sanitizePayload(payload: ParentVerificationCommentPayload): ParentVerificationCommentPayload {
  const checked: string[] = [];
  for (const entry of payload.checked) {
    if (checked.length >= MAX_CHECKED_ITEMS) break;
    const text = trimText(entry);
    if (text) checked.push(text);
  }

  const evidence: ParentVerificationEvidence[] = [];
  for (const entry of payload.evidence) {
    if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
    const url = trimText(entry?.url);
    if (!url) continue;
    const note = trimText(entry?.note);
    evidence.push(note ? { url, note } : { url });
  }

  return {
    confidence: payload.confidence,
    checked,
    whySatisfied: trimText(payload.whySatisfied) || "Verified completion via parent verification.",
    evidence,
  };
}

export function buildParentVerificationComment(params: {
  marker: string;
  payload: ParentVerificationCommentPayload;
}): string {
  const payload = sanitizePayload(params.payload);
  const markerJson = JSON.stringify({
    version: 1,
    work_remains: false,
    confidence: payload.confidence,
    checked: payload.checked,
    why_satisfied: payload.whySatisfied,
    evidence: payload.evidence,
  });

  return [
    params.marker,
    "Verification complete — no PR needed.",
    `RALPH_VERIFY: ${markerJson}`,
  ].join("\n");
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
          createdAt
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
            nodes?: Array<{
              body?: string | null;
              databaseId?: number | null;
              url?: string | null;
              createdAt?: string | null;
            }>;
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
    createdAt: node?.createdAt ?? null,
  }));
  const reachedMax = Boolean(response.data?.data?.repository?.issue?.comments?.pageInfo?.hasPreviousPage);

  return { comments, reachedMax };
}

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function planVerificationCommentWrite(params: {
  desiredBody: string;
  markerId: string;
  marker: string;
  scannedComments: IssueComment[];
}): {
  action: "noop" | "patch" | "post";
  markerFound: boolean;
  targetCommentId?: number | null;
  targetCommentUrl?: string | null;
} {
  const desired = params.desiredBody.trim();
  const matches = params.scannedComments.filter((comment) => {
    const body = comment.body ?? "";
    const found = extractExistingMarker(body);
    return found ? found.toLowerCase() === params.markerId.toLowerCase() : body.includes(params.marker);
  });

  if (!matches.length) {
    return { action: "post", markerFound: false };
  }

  const selected = matches.reduce((latest, current) => {
    const latestTs = toTimestamp(latest.createdAt);
    const currentTs = toTimestamp(current.createdAt);
    return currentTs >= latestTs ? current : latest;
  }, matches[0]);

  const existing = String(selected.body ?? "").trim();
  const action = existing === desired ? "noop" : "patch";

  return {
    action,
    markerFound: true,
    targetCommentId: selected.databaseId ?? null,
    targetCommentUrl: selected.url ?? null,
  };
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
  const marker = buildMarker({ issueNumber: ctx.issueNumber });
  const markerId = String(ctx.issueNumber);
  const commentBody = buildParentVerificationComment({ marker, payload: ctx.payload });
  const idempotencyKey = `gh-parent-verify:${ctx.repo}#${ctx.issueNumber}:verify-v1`;
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

  const plan = listResult
    ? planVerificationCommentWrite({
        desiredBody: commentBody,
        markerId,
        marker,
        scannedComments: listResult.comments,
      })
    : null;

  if (plan?.action === "noop") {
    commentOk = true;
    commentUrl = plan.targetCommentUrl ?? null;
    recordIdempotencyKey({ key: idempotencyKey, scope: "gh-parent-verify" });
  }

  if (plan?.action === "patch") {
    const commentId = plan.targetCommentId ?? null;
    commentUrl = plan.targetCommentUrl ?? null;
    if (!commentId) {
      return { ok: false, closed: false, labelOpsApplied: false, commentUrl, error: "Verification comment missing id" };
    }
    try {
      const updated = await updateIssueComment({
        github: deps.github,
        repo: ctx.repo,
        commentId,
        body: commentBody,
      });
      commentUrl = updated?.html_url ?? commentUrl;
      commentOk = true;
      recordIdempotencyKey({ key: idempotencyKey, scope: "gh-parent-verify" });
    } catch (error: any) {
      return {
        ok: false,
        closed: false,
        labelOpsApplied: false,
        commentUrl,
        error: `Failed to update verification comment: ${error?.message ?? String(error)}`,
      };
    }
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

  let labelOpsApplied = false;
  try {
    const ops = planIssueLabelOps({ add: [RALPH_LABEL_STATUS_DONE], remove: LABELS_TO_REMOVE });
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

  try {
    await closeIssue({ github: deps.github, repo: ctx.repo, issueNumber: ctx.issueNumber });
  } catch (error: any) {
    return {
      ok: false,
      closed: false,
      labelOpsApplied,
      commentUrl,
      error: `Failed to close issue: ${error?.message ?? String(error)}`,
    };
  }

  return { ok: true, commentUrl, closed: true, labelOpsApplied };
}
