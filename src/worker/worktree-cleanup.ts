import { $ } from "bun";

import type { AgentTask } from "../queue-backend";
import { getConfig } from "../config";
import { detectLegacyWorktrees } from "../git-worktree";
import { formatLegacyWorktreeWarning } from "../legacy-worktrees";

export async function getGitWorktrees(worker: any): Promise<any[]> {
  return await worker.worktrees.getGitWorktrees();
}

export async function pruneGitWorktreesOnStartup(worker: any): Promise<void> {
  await $`git worktree prune`.cwd(worker.repoPath).quiet();
}

export async function cleanupOrphanedWorktreesOnStartup(worker: any): Promise<void> {
  await worker.worktrees.cleanupOrphanedWorktrees();
}

export async function warnLegacyWorktreesOnStartup(
  worker: any,
  params: { managedRoot: string; legacyLogIntervalMs: number }
): Promise<void> {
  const config = getConfig();
  const entries = await worker.worktrees.getGitWorktrees();
  const legacy = detectLegacyWorktrees(entries, {
    devDir: config.devDir,
    managedRoot: params.managedRoot,
  });

  if (legacy.length === 0) return;

  const key = `${worker.repo}:legacy-worktrees`;
  if (!worker.legacyWorktreesLogLimiter.shouldLog(key, params.legacyLogIntervalMs)) return;

  console.warn(
    formatLegacyWorktreeWarning({
      repo: worker.repo,
      repoPath: worker.repoPath,
      devDir: config.devDir,
      managedRoot: params.managedRoot,
      legacyPaths: legacy.map((entry: any) => entry.worktreePath),
    })
  );
}

export async function cleanupWorktreesForTasks(worker: any, tasks: AgentTask[]): Promise<void> {
  await worker.worktrees.cleanupWorktreesForTasks(tasks);
}
