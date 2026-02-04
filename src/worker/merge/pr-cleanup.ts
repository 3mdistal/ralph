import { computeHeadBranchDeletionDecision } from "../../pr-head-branch-cleanup";
import { splitRepoFullName } from "../../github/client";

import { extractPullRequestNumber } from "../lanes/required-checks";

export type PullRequestDetailsNormalized = {
  number: number;
  url: string;
  merged: boolean;
  baseRefName: string;
  headRefName: string;
  headRepoFullName: string;
  headSha: string;
};

type PullRequestDetails = {
  number?: number;
  url?: string;
  merged?: boolean;
  merged_at?: string | null;
  base?: { ref?: string | null } | null;
  head?: {
    ref?: string | null;
    sha?: string | null;
    repo?: { full_name?: string | null } | null;
  } | null;
};

export async function fetchPullRequestDetails(params: {
  repo: string;
  prUrl: string;
  githubApiRequest: <T>(path: string) => Promise<T | null>;
}): Promise<PullRequestDetailsNormalized> {
  const prNumber = extractPullRequestNumber(params.prUrl);
  if (!prNumber) {
    throw new Error(`Could not parse pull request number from URL: ${params.prUrl}`);
  }

  const { owner, name } = splitRepoFullName(params.repo);
  const payload = await params.githubApiRequest<PullRequestDetails>(`/repos/${owner}/${name}/pulls/${prNumber}`);

  const mergedFlag = payload?.merged ?? null;
  const mergedAt = payload?.merged_at ?? null;
  const merged = mergedFlag === true || Boolean(mergedAt);

  return {
    number: Number(payload?.number ?? prNumber),
    url: String(payload?.url ?? params.prUrl),
    merged,
    baseRefName: String(payload?.base?.ref ?? ""),
    headRefName: String(payload?.head?.ref ?? ""),
    headRepoFullName: String(payload?.head?.repo?.full_name ?? ""),
    headSha: String(payload?.head?.sha ?? ""),
  };
}

export async function fetchMergedPullRequestDetails(params: {
  prUrl: string;
  attempts: number;
  delayMs: number;
  fetchPullRequestDetails: (prUrl: string) => Promise<PullRequestDetailsNormalized>;
}): Promise<PullRequestDetailsNormalized> {
  let last = await params.fetchPullRequestDetails(params.prUrl);
  for (let attempt = 1; attempt < params.attempts; attempt += 1) {
    if (last.merged) return last;
    await new Promise((resolve) => setTimeout(resolve, params.delayMs));
    last = await params.fetchPullRequestDetails(params.prUrl);
  }
  return last;
}

export async function deleteMergedPrHeadBranchBestEffort(params: {
  repo: string;
  prUrl: string;
  botBranch: string;
  mergedHeadSha: string;
  fetchMergedPullRequestDetails: (prUrl: string, attempts: number, delayMs: number) => Promise<PullRequestDetailsNormalized>;
  fetchRepoDefaultBranch: () => Promise<string | null>;
  fetchGitRef: (path: string) => Promise<{ object?: { sha?: string | null } | null } | null>;
  deletePrHeadBranch: (branch: string) => Promise<"deleted" | "missing">;
  formatGhError: (error: unknown) => string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<void> {
  const log = params.log ?? ((message: string) => console.log(message));
  const warn = params.warn ?? ((message: string) => console.warn(message));

  let details: PullRequestDetailsNormalized;
  try {
    details = await params.fetchMergedPullRequestDetails(params.prUrl, 3, 1000);
  } catch (error: any) {
    warn(
      `[ralph:worker:${params.repo}] Failed to read PR details for head branch cleanup: ${params.formatGhError(error)}`
    );
    return;
  }

  if (!details.merged) {
    log(`[ralph:worker:${params.repo}] Skipped PR head branch deletion (not merged): ${params.prUrl}`);
    return;
  }

  let defaultBranch: string | null = null;
  try {
    defaultBranch = await params.fetchRepoDefaultBranch();
  } catch (error: any) {
    warn(
      `[ralph:worker:${params.repo}] Failed to fetch default branch for cleanup: ${params.formatGhError(error)}`
    );
  }

  let currentHeadSha: string | null = null;
  if (details.headRefName) {
    const headRef = await params.fetchGitRef(`heads/${details.headRefName}`);
    currentHeadSha = headRef?.object?.sha ? String(headRef.object.sha) : null;
  }

  const sameRepo = details.headRepoFullName.trim().toLowerCase() === params.repo.toLowerCase();
  const decision = computeHeadBranchDeletionDecision({
    merged: details.merged,
    isCrossRepository: !sameRepo,
    headRepoFullName: details.headRepoFullName,
    headRefName: details.headRefName,
    baseRefName: details.baseRefName,
    botBranch: params.botBranch,
    defaultBranch,
    mergedHeadSha: params.mergedHeadSha,
    currentHeadSha,
  });

  if (decision.action === "skip") {
    log(
      `[ralph:worker:${params.repo}] Skipped PR head branch deletion (${decision.reason}): ${params.prUrl}`
    );
    return;
  }

  try {
    const result = await params.deletePrHeadBranch(decision.branch);
    if (result === "missing") {
      log(
        `[ralph:worker:${params.repo}] PR head branch already missing (${decision.branch}): ${params.prUrl}`
      );
      return;
    }
    log(`[ralph:worker:${params.repo}] Deleted PR head branch ${decision.branch}: ${params.prUrl}`);
  } catch (error: any) {
    warn(
      `[ralph:worker:${params.repo}] Failed to delete PR head branch ${decision.branch}: ${params.formatGhError(error)}`
    );
  }
}

export async function deletePrHeadBranch(params: {
  repo: string;
  branch: string;
  githubRequest: (
    path: string,
    opts: { method: "DELETE"; allowNotFound: boolean }
  ) => Promise<{ status: number }>;
}): Promise<"deleted" | "missing"> {
  const { owner, name } = splitRepoFullName(params.repo);
  const encoded = params.branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await params.githubRequest(`/repos/${owner}/${name}/git/refs/heads/${encoded}`, {
    method: "DELETE",
    allowNotFound: true,
  });
  if (response.status === 404) return "missing";
  return "deleted";
}
