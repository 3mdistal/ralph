import { createGhRunner } from "../../github/gh-runner";
import { splitRepoFullName } from "../../github/client";

import {
  extractPullRequestNumber,
  normalizeRequiredCheckState,
  type PrCheck,
} from "../lanes/required-checks";

export type PullRequestMergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNSTABLE"
  | "UNKNOWN";

export function normalizeMergeStateStatus(value: unknown): PullRequestMergeStateStatus | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  switch (upper) {
    case "BEHIND":
    case "BLOCKED":
    case "CLEAN":
    case "DIRTY":
    case "DRAFT":
    case "HAS_HOOKS":
    case "UNSTABLE":
    case "UNKNOWN":
      return upper as PullRequestMergeStateStatus;
    default:
      return "UNKNOWN";
  }
}

const ghRead = (repo: string) => createGhRunner({ repo, mode: "read" });
const ghWrite = (repo: string) => createGhRunner({ repo, mode: "write" });

export async function getPullRequestChecks(params: {
  repo: string;
  prUrl: string;
}): Promise<{
  headSha: string;
  mergeStateStatus: PullRequestMergeStateStatus | null;
  baseRefName: string;
  checks: PrCheck[];
}> {
  const prNumber = extractPullRequestNumber(params.prUrl);
  if (!prNumber) {
    throw new Error(`Could not parse pull request number from URL: ${params.prUrl}`);
  }

  const { owner, name } = splitRepoFullName(params.repo);

  const query = [
    "query($owner:String!,$name:String!,$number:Int!){",
    "repository(owner:$owner,name:$name){",
    "pullRequest(number:$number){",
    "headRefOid",
    "mergeStateStatus",
    "baseRefName",
    "statusCheckRollup{",
    "contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}",
    "}",
    "}",
    "}",
    "}",
  ].join(" ");

  const result = await ghRead(params.repo)`gh api graphql -f query=${query} -f owner=${owner} -f name=${name} -F number=${prNumber}`.quiet();
  const parsed = JSON.parse(result.stdout.toString());

  const pr = parsed?.data?.repository?.pullRequest;
  const headSha = pr?.headRefOid as string | undefined;
  if (!headSha) {
    throw new Error(`Failed to read pull request head SHA for ${params.prUrl}`);
  }

  const mergeStateStatus = normalizeMergeStateStatus(pr?.mergeStateStatus);
  const baseRefName = String(pr?.baseRefName ?? "").trim();
  if (!baseRefName) {
    throw new Error(`Failed to read pull request base branch for ${params.prUrl}`);
  }

  const nodes = pr?.statusCheckRollup?.contexts?.nodes;
  const checksRaw = Array.isArray(nodes) ? nodes : [];
  const checks: PrCheck[] = [];

  for (const node of checksRaw) {
    const type = String(node?.__typename ?? "");

    if (type === "CheckRun") {
      const checkName = String(node?.name ?? "").trim();
      if (!checkName) continue;

      const status = String(node?.status ?? "");
      const conclusion = String(node?.conclusion ?? "");
      const detailsUrl = node?.detailsUrl ? String(node.detailsUrl).trim() : null;

      // If it's not completed yet, treat status as the state.
      const rawState = status && status !== "COMPLETED" ? status : conclusion || status || "UNKNOWN";
      checks.push({ name: checkName, rawState, state: normalizeRequiredCheckState(rawState), detailsUrl });
      continue;
    }

    if (type === "StatusContext") {
      const checkName = String(node?.context ?? "").trim();
      if (!checkName) continue;

      const rawState = String(node?.state ?? "UNKNOWN");
      const detailsUrl = node?.targetUrl ? String(node.targetUrl).trim() : null;
      checks.push({ name: checkName, rawState, state: normalizeRequiredCheckState(rawState), detailsUrl });
      continue;
    }
  }

  return { headSha, mergeStateStatus, baseRefName, checks };
}

export async function getPullRequestBaseBranch(params: {
  repo: string;
  prUrl: string;
}): Promise<string | null> {
  const prNumber = extractPullRequestNumber(params.prUrl);
  if (!prNumber) return null;

  const { owner, name } = splitRepoFullName(params.repo);
  const query = [
    "query($owner:String!,$name:String!,$number:Int!){",
    "repository(owner:$owner,name:$name){",
    "pullRequest(number:$number){",
    "baseRefName",
    "}",
    "}",
    "}",
  ].join(" ");

  const result = await ghRead(params.repo)`gh api graphql -f query=${query} -f owner=${owner} -f name=${name} -F number=${prNumber}`.quiet();
  const parsed = JSON.parse(result.stdout.toString());
  const base = parsed?.data?.repository?.pullRequest?.baseRefName;
  return typeof base === "string" && base.trim() ? base.trim() : null;
}

export async function mergePullRequest(params: {
  repo: string;
  prUrl: string;
  headSha: string;
  cwd: string;
}): Promise<void> {
  const prNumber = extractPullRequestNumber(params.prUrl);
  if (!prNumber) {
    throw new Error(`Could not parse pull request number from URL: ${params.prUrl}`);
  }

  const { owner, name } = splitRepoFullName(params.repo);

  // Never pass --admin or -d (delete branch). Branch cleanup is handled separately with guardrails.
  // Use the merge REST API to avoid interactive gh pr merge behavior in daemon mode.
  await ghWrite(params.repo)`gh api -X PUT /repos/${owner}/${name}/pulls/${prNumber}/merge -f merge_method=merge -f sha=${params.headSha}`
    .cwd(params.cwd)
    .quiet();
}
