import { $ } from "bun";

import type { IssueMetadata } from "../escalation";
import type { IssueRef } from "../github/issue-ref";
import { splitRepoFullName, type GitHubClient } from "../github/client";
import { ensureRalphWorkflowLabelsOnce } from "../github/ensure-ralph-workflow-labels";
import { executeIssueLabelOps, planIssueLabelOps } from "../github/issue-label-io";
import { normalizePrUrl, searchMergedPullRequestsByIssueLink, viewPullRequestMergeCommit } from "../github/pr";
import { PR_STATE_MERGED, listMergedPrCandidatesForIssue, recordPrSnapshot } from "../state";
import {
  buildParentVerificationComment,
  type ParentVerificationChild,
  type ParentVerificationEvidence,
  type ParentVerificationPromptInput,
} from "./core";

export type ParentVerificationContext = ParentVerificationPromptInput & {
  children: ParentVerificationChild[];
  diagnostics: string[];
};

type EvidenceResult = {
  childIssues: IssueRef[];
  children: ParentVerificationChild[];
  evidence: ParentVerificationEvidence[];
  diagnostics: string[];
};

type IssueComment = { id: number; body: string; url?: string | null };

const MAX_PRS_PER_CHILD = 3;
const MAX_EVIDENCE_TOTAL = 200;
const DEFAULT_COMMENT_SCAN_LIMIT = 100;
const PARENT_VERIFY_MARKER_PREFIX = "<!-- ralph-parent-verify:id=";
const PARENT_VERIFY_MARKER_REGEX = /<!--\s*ralph-parent-verify:id=([a-f0-9]+)\s*-->/i;

function buildIssueUrl(issue: IssueRef): string {
  return `https://github.com/${issue.repo}/issues/${issue.number}`;
}

function buildCommitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

function normalizeGitHubUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!/^https:\/\/github\.com\//i.test(trimmed)) return "";
  return trimmed;
}

function dedupeOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeGitHubUrl(normalizePrUrl(value) ?? value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function sortIssues(issues: IssueRef[]): IssueRef[] {
  return [...issues].sort((a, b) => {
    const repoCompare = a.repo.localeCompare(b.repo);
    if (repoCompare !== 0) return repoCompare;
    return a.number - b.number;
  });
}

function sortPrUrls(urls: string[]): string[] {
  return [...urls].sort((a, b) => a.localeCompare(b));
}

function hashFNV1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildMarkerId(params: { repo: string; issueNumber: number; childIssues: IssueRef[] }): string {
  const childKey = sortIssues(params.childIssues).map((issue) => `${issue.repo}#${issue.number}`).join(",");
  const base = [params.repo, params.issueNumber, childKey].join("|");
  return `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
}

function buildMarker(params: { repo: string; issueNumber: number; childIssues: IssueRef[] }): string {
  const markerId = buildMarkerId(params);
  return `${PARENT_VERIFY_MARKER_PREFIX}${markerId} -->`;
}

function extractExistingMarker(body: string): string | null {
  const match = body.match(PARENT_VERIFY_MARKER_REGEX);
  return match?.[1] ?? null;
}

function stateForChild(signalState?: string): "open" | "closed" | "unknown" {
  if (signalState === "open" || signalState === "closed") return signalState;
  return "unknown";
}

export async function ensureCleanWorktree(worktreePath: string): Promise<{ clean: boolean; status: string }> {
  try {
    const status = await $`git status --porcelain`.cwd(worktreePath).quiet();
    const text = status.stdout.toString().trim();
    return { clean: !text, status: text };
  } catch (error: any) {
    return { clean: false, status: `ERROR: ${error?.message ?? String(error)}` };
  }
}

async function collectParentVerificationEvidence(params: {
  childIssues: IssueRef[];
  childStates: Map<string, "open" | "closed" | "unknown">;
}): Promise<EvidenceResult> {
  const childIssues = sortIssues(params.childIssues);
  const evidence: ParentVerificationEvidence[] = [];
  const diagnostics: string[] = [];
  const children: ParentVerificationChild[] = [];

  for (const issue of childIssues) {
    const key = `${issue.repo}#${issue.number}`;
    const state = params.childStates.get(key) ?? "unknown";
    const childEvidence: ParentVerificationEvidence[] = [];

    const issueUrl = normalizeGitHubUrl(buildIssueUrl(issue));
    if (!issueUrl) continue;
    childEvidence.push({ kind: "issue", url: issueUrl, label: "Issue" });
    evidence.push({ kind: "issue", url: issueUrl, label: "Issue" });
    if (evidence.length >= MAX_EVIDENCE_TOTAL) break;

    const snapshotCandidates = listMergedPrCandidatesForIssue(issue.repo, issue.number).map(
      (row: { url: string }) => row.url
    );
    let searchCandidates: string[] = [];
    try {
      const searchResults = await searchMergedPullRequestsByIssueLink(issue.repo, String(issue.number));
      searchCandidates = searchResults.map((row: { url: string }) => row.url);
    } catch (error: any) {
      diagnostics.push(
        `- Failed to search merged PRs for ${issue.repo}#${issue.number}: ${error?.message ?? String(error)}`
      );
    }

    const prCandidates = sortPrUrls(dedupeOrdered([...snapshotCandidates, ...searchCandidates])).slice(0, MAX_PRS_PER_CHILD);
    for (const prUrlRaw of prCandidates) {
      const prUrl = normalizeGitHubUrl(normalizePrUrl(prUrlRaw) ?? prUrlRaw);
      if (!prUrl) continue;
      const prEvidence = { kind: "pr" as const, url: prUrl, label: "PR" };
      childEvidence.push(prEvidence);
      evidence.push(prEvidence);
      recordPrSnapshot({ repo: issue.repo, issue: `${issue.repo}#${issue.number}`, prUrl, state: PR_STATE_MERGED });
      if (evidence.length >= MAX_EVIDENCE_TOTAL) break;

      try {
        const mergeCommit = await viewPullRequestMergeCommit(issue.repo, prUrl);
        if (mergeCommit?.sha) {
          const commitUrl = normalizeGitHubUrl(buildCommitUrl(issue.repo, mergeCommit.sha));
          const commitEvidence = { kind: "commit" as const, url: commitUrl, label: "Commit" };
          childEvidence.push(commitEvidence);
          evidence.push(commitEvidence);
        }
      } catch (error: any) {
        diagnostics.push(`- Failed to read merge commit for ${prUrl}: ${error?.message ?? String(error)}`);
      }

      if (evidence.length >= MAX_EVIDENCE_TOTAL) break;
    }

    children.push({
      ref: issue,
      url: issueUrl,
      state: stateForChild(state),
      evidence: childEvidence,
    });

    if (evidence.length >= MAX_EVIDENCE_TOTAL) break;
  }

  return { childIssues, children, evidence, diagnostics };
}

export async function buildParentVerificationContext(params: {
  repo: string;
  issueNumber: number;
  issueMeta: IssueMetadata;
  snapshot: { signals: Array<{ kind: string; state: string; ref?: IssueRef }> };
  childRefs: IssueRef[];
  github: GitHubClient;
}): Promise<ParentVerificationContext> {
  const fallbackIssueUrl = `https://github.com/${params.repo}/issues/${params.issueNumber}`;
  const issueUrl = normalizeGitHubUrl(params.issueMeta.url ?? fallbackIssueUrl) || fallbackIssueUrl;
  const childStates = new Map<string, "open" | "closed" | "unknown">();
  for (const signal of params.snapshot.signals ?? []) {
    if (signal.kind !== "sub_issue" || !signal.ref) continue;
    const key = `${signal.ref.repo}#${signal.ref.number}`;
    childStates.set(key, stateForChild(signal.state));
  }

  const evidenceResult = await collectParentVerificationEvidence({
    childIssues: params.childRefs,
    childStates,
  });

  return {
    repo: params.repo,
    issueNumber: params.issueNumber,
    issueUrl,
    childIssues: evidenceResult.childIssues,
    evidence: evidenceResult.evidence,
    children: evidenceResult.children,
    diagnostics: evidenceResult.diagnostics,
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
  const comments = nodes
    .map((node) => ({
      id: typeof node?.databaseId === "number" ? node.databaseId : 0,
      body: node?.body ?? "",
      url: node?.url ?? null,
    }))
    .filter((node) => node.id > 0);
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

export async function writeParentVerificationToGitHub(params: {
  context: ParentVerificationContext;
  github: GitHubClient;
  removeLabels: string[];
}): Promise<{ ok: boolean; error?: string; commentUrl?: string | null }> {
  const { context } = params;
  const marker = buildMarker({
    repo: context.repo,
    issueNumber: context.issueNumber,
    childIssues: context.childIssues,
  });
  const commentBody = buildParentVerificationComment({
    marker,
    childIssues: context.childIssues,
    evidence: context.evidence,
  });
  const markerId = buildMarkerId({ repo: context.repo, issueNumber: context.issueNumber, childIssues: context.childIssues });
  let commentUrl: string | null = null;
  let existingCommentId: number | null = null;
  let existingBody: string | null = null;

  try {
    const listResult = await listRecentIssueComments({
      github: params.github,
      repo: context.repo,
      issueNumber: context.issueNumber,
      limit: DEFAULT_COMMENT_SCAN_LIMIT,
    });
    if (listResult.reachedMax) {
      console.warn(
        `[ralph:parent-verify:${context.repo}] Comment scan hit cap (${DEFAULT_COMMENT_SCAN_LIMIT}); marker detection may be incomplete.`
      );
    }

    const markerIdLower = markerId.toLowerCase();
    for (const comment of listResult.comments) {
      const found = extractExistingMarker(comment.body ?? "");
      const match = found ? found.toLowerCase() === markerIdLower : (comment.body ?? "").includes(marker);
      if (match) {
        existingCommentId = comment.id;
        existingBody = comment.body ?? "";
      }
    }
  } catch (error: any) {
    console.warn(`[ralph:parent-verify:${context.repo}] Failed to list issue comments: ${error?.message ?? String(error)}`);
  }

  try {
    if (existingCommentId) {
      if ((existingBody ?? "").trim() !== commentBody.trim()) {
        const updated = await updateIssueComment({
          github: params.github,
          repo: context.repo,
          commentId: existingCommentId,
          body: commentBody,
        });
        commentUrl = updated?.html_url ?? null;
      }
    } else {
      const created = await createIssueComment({
        github: params.github,
        repo: context.repo,
        issueNumber: context.issueNumber,
        body: commentBody,
      });
      commentUrl = created?.html_url ?? null;
    }
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }

  try {
    await closeIssue({ github: params.github, repo: context.repo, issueNumber: context.issueNumber });
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }

  if (params.removeLabels.length > 0) {
    const ops = planIssueLabelOps({ add: [], remove: params.removeLabels });
    const labelResult = await executeIssueLabelOps({
      github: params.github,
      repo: context.repo,
      issueNumber: context.issueNumber,
      ops,
      logLabel: `${context.repo}#${context.issueNumber}`,
      log: (message) => console.warn(`[ralph:parent-verify:${context.repo}] ${message}`),
      ensureLabels: async () => await ensureRalphWorkflowLabelsOnce({ repo: context.repo, github: params.github }),
      retryMissingLabelOnce: true,
      ensureBefore: true,
    });
    if (!labelResult.ok) {
      console.warn(`[ralph:parent-verify:${context.repo}] Failed to remove labels; continuing.`);
    }
  }

  return { ok: true, commentUrl };
}
