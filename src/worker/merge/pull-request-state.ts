import { createGhRunner } from "../../github/gh-runner";
import { splitRepoFullName } from "../../github/client";
import { extractPullRequestNumber } from "../lanes/required-checks";

import { normalizeMergeStateStatus } from "./pull-request-io";

const ghRead = (repo: string) => createGhRunner({ repo, mode: "read", lane: "critical", source: "merge:state" });

export async function getPullRequestMergeState(params: {
  repo: string;
  prUrl: string;
}): Promise<{
  number: number;
  url: string;
  mergeStateStatus: ReturnType<typeof normalizeMergeStateStatus>;
  isCrossRepository: boolean;
  headRefName: string;
  headRepoFullName: string;
  baseRefName: string;
  labels: string[];
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
    "number",
    "url",
    "mergeStateStatus",
    "isCrossRepository",
    "headRefName",
    "baseRefName",
    "headRepository{ nameWithOwner }",
    "labels(first:100){nodes{name}}",
    "}",
    "}",
    "}",
  ].join(" ");

  const result = await ghRead(params.repo)`gh api graphql -f query=${query} -f owner=${owner} -f name=${name} -F number=${prNumber}`.quiet();
  const parsed = JSON.parse(result.stdout.toString());
  const pr = parsed?.data?.repository?.pullRequest;

  if (!pr?.url) {
    throw new Error(`Failed to read pull request metadata for ${params.prUrl}`);
  }

  const labels = Array.isArray(pr?.labels?.nodes)
    ? pr.labels.nodes.map((node: any) => String(node?.name ?? "").trim()).filter(Boolean)
    : [];

  return {
    number: Number(pr?.number ?? prNumber),
    url: String(pr?.url ?? params.prUrl),
    mergeStateStatus: normalizeMergeStateStatus(pr?.mergeStateStatus),
    isCrossRepository: Boolean(pr?.isCrossRepository),
    headRefName: String(pr?.headRefName ?? ""),
    headRepoFullName: String(pr?.headRepository?.nameWithOwner ?? ""),
    baseRefName: String(pr?.baseRefName ?? ""),
    labels,
  };
}
