import { normalizeGitRef } from "./midpoint-labels";

export type HeadBranchDeletionDecision =
  | { action: "delete"; branch: string; reason: string }
  | { action: "skip"; reason: string };

export type HeadBranchDeletionInput = {
  merged: boolean;
  isCrossRepository: boolean;
  headRepoFullName: string;
  headRefName: string;
  baseRefName: string;
  botBranch: string;
  defaultBranch: string | null;
  mergedHeadSha: string;
  currentHeadSha: string | null;
};

export function computeHeadBranchDeletionDecision(input: HeadBranchDeletionInput): HeadBranchDeletionDecision {
  if (!input.merged) {
    return { action: "skip", reason: "pr not merged" };
  }
  if (input.isCrossRepository) {
    return { action: "skip", reason: "pr is cross-repo" };
  }

  const headRef = normalizeGitRef(input.headRefName);
  const baseRef = normalizeGitRef(input.baseRefName);
  const botRef = normalizeGitRef(input.botBranch);
  const defaultRef = input.defaultBranch ? normalizeGitRef(input.defaultBranch) : "";

  if (!headRef) {
    return { action: "skip", reason: "missing head ref" };
  }
  if (!baseRef || baseRef !== botRef) {
    return { action: "skip", reason: "base not bot branch" };
  }
  if (!input.headRepoFullName.trim()) {
    return { action: "skip", reason: "missing head repo" };
  }
  if (headRef === botRef) {
    return { action: "skip", reason: "head is bot branch" };
  }
  if (defaultRef && headRef === defaultRef) {
    return { action: "skip", reason: "head is default branch" };
  }
  if (!input.mergedHeadSha.trim()) {
    return { action: "skip", reason: "missing merged head sha" };
  }
  if (!input.currentHeadSha) {
    return { action: "skip", reason: "head ref missing" };
  }
  if (input.currentHeadSha !== input.mergedHeadSha) {
    return { action: "skip", reason: "head ref moved" };
  }

  return { action: "delete", branch: headRef, reason: "eligible" };
}
