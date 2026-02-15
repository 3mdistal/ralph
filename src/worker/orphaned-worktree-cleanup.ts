import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join, resolve } from "path";

import { classifyManagedWorktreePath, isManagedWorktreeRootClassification } from "../worktree-layout";

export type OrphanedWorktreeCleanupAction =
  | { kind: "remove-registered-via-git"; worktreePath: string }
  | { kind: "remove-unregistered-via-fs"; worktreePath: string };

export async function discoverManagedWorktreeRoots(repoDir: string, managedRoot: string): Promise<string[]> {
  if (!existsSync(repoDir)) return [];

  const discovered = new Set<string>();
  const addIfRoot = (candidatePath: string) => {
    const classification = classifyManagedWorktreePath(candidatePath, managedRoot);
    if (!isManagedWorktreeRootClassification(classification)) return;
    discovered.add(classification.normalizedPath);
  };

  let topEntries: { name: string; isDirectory(): boolean }[] = [];
  try {
    topEntries = await readdir(repoDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const topEntry of topEntries) {
    if (!topEntry.isDirectory()) continue;
    const topPath = join(repoDir, topEntry.name);

    if (/^slot-\d+$/.test(topEntry.name)) {
      let issueEntries: { name: string; isDirectory(): boolean }[] = [];
      try {
        issueEntries = await readdir(topPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const issueEntry of issueEntries) {
        if (!issueEntry.isDirectory()) continue;
        const issuePath = join(topPath, issueEntry.name);

        let taskEntries: { name: string; isDirectory(): boolean }[] = [];
        try {
          taskEntries = await readdir(issuePath, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const taskEntry of taskEntries) {
          if (!taskEntry.isDirectory()) continue;
          addIfRoot(join(issuePath, taskEntry.name));
        }
      }

      continue;
    }

    let taskEntries: { name: string; isDirectory(): boolean }[] = [];
    try {
      taskEntries = await readdir(topPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory()) continue;
      addIfRoot(join(topPath, taskEntry.name));
    }
  }

  return [...discovered];
}

export function planOrphanedWorktreeCleanup(params: {
  gitInventoryOk: boolean;
  registeredWorktreePaths: string[];
  discoveredWorktreeRoots: string[];
  managedRoot: string;
  repoRoot: string;
  isRepoWorktreePath: (path: string) => boolean;
  isHealthyWorktreePath: (path: string) => boolean;
}): OrphanedWorktreeCleanupAction[] {
  if (!params.gitInventoryOk) return [];

  const actions: OrphanedWorktreeCleanupAction[] = [];
  const known = new Set(params.registeredWorktreePaths.map((path) => resolve(path)));
  const repoRoot = resolve(params.repoRoot);
  const queued = new Set<string>();

  const queueAction = (action: OrphanedWorktreeCleanupAction) => {
    if (queued.has(action.worktreePath)) return;
    queued.add(action.worktreePath);
    actions.push(action);
  };

  for (const worktreePath of known) {
    if (worktreePath === repoRoot) continue;
    if (!params.isRepoWorktreePath(worktreePath)) continue;
    const classification = classifyManagedWorktreePath(worktreePath, params.managedRoot);
    if (!isManagedWorktreeRootClassification(classification)) continue;
    if (params.isHealthyWorktreePath(worktreePath)) continue;
    queueAction({ kind: "remove-registered-via-git", worktreePath });
  }

  for (const rawDiscovered of params.discoveredWorktreeRoots) {
    const discovered = resolve(rawDiscovered);
    if (known.has(discovered)) continue;
    if (discovered === repoRoot) continue;
    if (!params.isRepoWorktreePath(discovered)) continue;
    const classification = classifyManagedWorktreePath(discovered, params.managedRoot);
    if (!isManagedWorktreeRootClassification(classification)) continue;
    if (params.isHealthyWorktreePath(discovered)) continue;
    queueAction({ kind: "remove-unregistered-via-fs", worktreePath: discovered });
  }

  return actions;
}
