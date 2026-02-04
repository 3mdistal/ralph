import { $ } from "bun";

import { existsSync } from "fs";
import { join } from "path";

import { safeNoteName } from "../names";
import { extractPullRequestNumber } from "../lanes/required-checks";

type PullRequestMergeState = {
  url: string;
  mergeStateStatus: string | null;
  isCrossRepository: boolean;
  headRefName: string;
  headRepoFullName: string;
  baseRefName: string;
};

async function createAutoUpdateWorktree(params: {
  repo: string;
  prUrl: string;
  worktreesDir: string;
  ensureGitWorktree: (worktreePath: string) => Promise<void>;
  safeRemoveWorktree: (worktreePath: string, opts?: { allowDiskCleanup?: boolean }) => Promise<void>;
}): Promise<string> {
  const slug = safeNoteName(params.repo);
  const prNumber = extractPullRequestNumber(params.prUrl) ?? "unknown";
  const worktreePath = join(params.worktreesDir, slug, `pr-${prNumber}-auto-update`);

  if (existsSync(worktreePath)) {
    try {
      const status = await $`git status --porcelain`.cwd(worktreePath).quiet();
      if (status.stdout.toString().trim()) {
        await params.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
      }
    } catch {
      await params.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
    }
  }

  await params.ensureGitWorktree(worktreePath);
  return worktreePath;
}

export async function updatePullRequestBranchViaWorktree(params: {
  repo: string;
  prUrl: string;
  worktreesDir: string;
  botBranch: string;
  normalizeGitRef: (ref: string) => string;
  getPullRequestMergeState: (prUrl: string) => Promise<PullRequestMergeState>;
  ensureGitWorktree: (worktreePath: string) => Promise<void>;
  safeRemoveWorktree: (worktreePath: string, opts?: { allowDiskCleanup?: boolean }) => Promise<void>;
}): Promise<void> {
  const pr = await params.getPullRequestMergeState(params.prUrl);
  const botBranch = params.normalizeGitRef(params.botBranch);
  const headRef = params.normalizeGitRef(pr.headRefName);
  const baseRef = params.normalizeGitRef(pr.baseRefName || botBranch);

  if (pr.isCrossRepository || pr.headRepoFullName !== params.repo) {
    throw new Error(`Cannot update cross-repo PR ${params.prUrl}; requires same-repo branch access`);
  }

  if (pr.mergeStateStatus === "DIRTY") {
    throw new Error(`Refusing to update PR with merge conflicts: ${params.prUrl}`);
  }

  if (pr.mergeStateStatus === "DRAFT") {
    throw new Error(`Refusing to update draft PR: ${params.prUrl}`);
  }

  if (!headRef) {
    throw new Error(`PR missing head ref for update: ${params.prUrl}`);
  }

  const worktreePath = await createAutoUpdateWorktree({
    repo: params.repo,
    prUrl: params.prUrl,
    worktreesDir: params.worktreesDir,
    ensureGitWorktree: params.ensureGitWorktree,
    safeRemoveWorktree: params.safeRemoveWorktree,
  });

  try {
    await $`git fetch origin`.cwd(worktreePath).quiet();
    await $`git checkout ${headRef}`.cwd(worktreePath).quiet();
    await $`git merge --no-edit origin/${baseRef}`.cwd(worktreePath).quiet();
    await $`git push origin ${headRef}`.cwd(worktreePath).quiet();
  } catch (error: any) {
    const message = error?.message ?? String(error);
    throw new Error(`Worktree update failed for ${params.prUrl}: ${message}`);
  } finally {
    await params.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
  }
}
