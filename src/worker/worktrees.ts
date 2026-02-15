import { $ } from "bun";
import { existsSync, realpathSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { dirname, join, resolve } from "path";

import type { AgentTask } from "../queue-backend";
import { getRepoBotBranch } from "../config";
import { buildWorktreePath } from "../worktree-paths";
import { isPathUnderDir, parseGitWorktreeListPorcelain, type GitWorktreeEntry } from "../git-worktree";
import { classifyManagedWorktreePath, isManagedWorktreeRootClassification } from "../worktree-layout";

import { discoverManagedWorktreeRoots, planOrphanedWorktreeCleanup } from "./orphaned-worktree-cleanup";

import { safeNoteName } from "./names";

export type WorktreeQueueAdapter = {
  updateTaskStatus: (task: AgentTask, status: AgentTask["status"], patch: Record<string, string>) => Promise<boolean>;
};

export type ResolveTaskRepoPathResult =
  | { kind: "ok"; repoPath: string; worktreePath?: string }
  | { kind: "reset"; reason: string };

export function createWorktreeManager(params: {
  repo: string;
  repoPath: string;
  worktreesDir: string;
  queue: WorktreeQueueAdapter;
}) {
  const repoSlug = params.repo.split("/")[1] ?? params.repo;
  const repoKey = safeNoteName(params.repo);

  const normalizeRepoRootPath = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };

  const isManagedWorktreePath = (worktreePath: string, baseDir = params.worktreesDir): boolean => {
    return isPathUnderDir(worktreePath, baseDir);
  };

  const isRepoWorktreePath = (worktreePath: string): boolean => {
    return (
      isManagedWorktreePath(worktreePath, join(params.worktreesDir, repoSlug)) ||
      isManagedWorktreePath(worktreePath, join(params.worktreesDir, repoKey))
    );
  };

  const isSameRepoRootPath = (worktreePath: string): boolean => {
    return normalizeRepoRootPath(params.repoPath) === normalizeRepoRootPath(worktreePath);
  };

  const isHealthyWorktreePath = (worktreePath: string): boolean => {
    return existsSync(worktreePath) && existsSync(join(worktreePath, ".git"));
  };

  const isBenignNotWorktreeError = (message: string): boolean => {
    return /(not a working tree|is not a working tree|is not a worktree|not a git repository)/i.test(message);
  };

  const safeRemoveWorktree = async (worktreePath: string, opts?: { allowDiskCleanup?: boolean }): Promise<void> => {
    const allowDiskCleanup = opts?.allowDiskCleanup ?? false;

    try {
      await $`git worktree remove --force ${worktreePath}`.cwd(params.repoPath).quiet();
      return;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (!isBenignNotWorktreeError(msg)) {
        console.warn(`[ralph:worker:${params.repo}] Failed to remove worktree ${worktreePath}: ${msg}`);
      }
    }

    if (!allowDiskCleanup) return;

    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  const resolveWorktreeRef = async (): Promise<string> => {
    const botBranch = getRepoBotBranch(params.repo);
    try {
      await $`git rev-parse --verify ${botBranch}`.cwd(params.repoPath).quiet();
      return botBranch;
    } catch {
      return "HEAD";
    }
  };

  const ensureGitWorktree = async (worktreePath: string): Promise<void> => {
    const hasHealthyWorktree = () => isHealthyWorktreePath(worktreePath);

    const cleanupBrokenWorktree = async (): Promise<void> => {
      try {
        await $`git worktree remove --force ${worktreePath}`.cwd(params.repoPath).quiet();
      } catch {
        // ignore
      }

      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    // If git knows about the worktree but the path is broken, clean it up.
    try {
      const list = await $`git worktree list --porcelain`.cwd(params.repoPath).quiet();
      const out = list.stdout.toString();
      if (out.includes(`worktree ${worktreePath}\n`)) {
        if (hasHealthyWorktree()) return;
        console.warn(`[ralph:worker:${params.repo}] Worktree registered but unhealthy; recreating: ${worktreePath}`);
        await cleanupBrokenWorktree();
      }
    } catch {
      // ignore and attempt create
    }

    // If the directory exists but is not a valid git worktree, remove it.
    if (existsSync(worktreePath) && !hasHealthyWorktree()) {
      console.warn(`[ralph:worker:${params.repo}] Worktree path exists but is not a worktree; recreating: ${worktreePath}`);
      await cleanupBrokenWorktree();
    }

    await mkdir(dirname(worktreePath), { recursive: true });

    const ref = await resolveWorktreeRef();
    const create = async () => {
      await $`git worktree add --detach ${worktreePath} ${ref}`.cwd(params.repoPath).quiet();
      if (!hasHealthyWorktree()) {
        throw new Error(`Worktree created but missing .git marker: ${worktreePath}`);
      }
    };

    try {
      await create();
    } catch {
      // Retry once after forcing cleanup. This handles half-created directories or stale git metadata.
      await cleanupBrokenWorktree();
      await create();
    }
  };

  const getGitWorktreesWithStatus = async (): Promise<{ ok: true; entries: GitWorktreeEntry[] } | { ok: false; error: string }> => {
    try {
      const result = await $`git worktree list --porcelain`.cwd(params.repoPath).quiet();
      return { ok: true, entries: parseGitWorktreeListPorcelain(result.stdout.toString()) };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };

  const getGitWorktrees = async (): Promise<GitWorktreeEntry[]> => {
    const result = await getGitWorktreesWithStatus();
    return result.ok ? result.entries : [];
  };

  const cleanupOrphanedWorktrees = async (): Promise<void> => {
    const inventory = await getGitWorktreesWithStatus();
    if (!inventory.ok) {
      console.warn(
        `[ralph:worker:${params.repo}] Skipping orphaned worktree cleanup: failed to list git worktrees (${inventory.error})`
      );
      return;
    }

    const entries = inventory.entries;

    const repoRoot = params.repoPath;
    const repoRootManaged = isManagedWorktreePath(repoRoot);
    if (repoRootManaged) return;

    const repoCandidates = [join(params.worktreesDir, repoSlug), join(params.worktreesDir, repoKey)];
    const discoveredRoots = new Set<string>();

    for (const repoDir of repoCandidates) {
      const roots = await discoverManagedWorktreeRoots(repoDir, params.worktreesDir);
      for (const root of roots) discoveredRoots.add(root);
    }

    const actions = planOrphanedWorktreeCleanup({
      gitInventoryOk: true,
      registeredWorktreePaths: entries.map((entry) => entry.worktreePath),
      discoveredWorktreeRoots: [...discoveredRoots],
      managedRoot: params.worktreesDir,
      repoRoot,
      isRepoWorktreePath,
      isHealthyWorktreePath,
    });

    const removeWorktreeDirBestEffort = async (worktreePath: string): Promise<void> => {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch (error: any) {
        const msg = error?.message ?? String(error);
        console.warn(`[ralph:worker:${params.repo}] Failed to remove stale worktree directory ${worktreePath}: ${msg}`);
      }
    };

    for (const action of actions) {
      if (isSameRepoRootPath(action.worktreePath)) continue;

      const classification = classifyManagedWorktreePath(action.worktreePath, params.worktreesDir);
      if (!isManagedWorktreeRootClassification(classification)) continue;

      if (action.kind === "remove-registered-via-git") {
        console.warn(`[ralph:worker:${params.repo}] Worktree registered but unhealthy; pruning: ${action.worktreePath}`);
        await safeRemoveWorktree(action.worktreePath, { allowDiskCleanup: false });
        continue;
      }

      if (!existsSync(action.worktreePath)) continue;
      console.warn(`[ralph:worker:${params.repo}] Stale worktree directory; pruning: ${action.worktreePath}`);
      await removeWorktreeDirBestEffort(action.worktreePath);
    }
  };

  const cleanupWorktreesForTasks = async (tasks: AgentTask[]): Promise<void> => {
    const managedPaths = new Set<string>();
    for (const task of tasks) {
      const recorded = task["worktree-path"]?.trim();
      if (recorded) managedPaths.add(recorded);
    }

    for (const worktreePath of managedPaths) {
      if (!isRepoWorktreePath(worktreePath)) continue;
      if (isHealthyWorktreePath(worktreePath)) continue;

      console.warn(`[ralph:worker:${params.repo}] Recorded worktree-path unhealthy; pruning: ${worktreePath}`);
      await safeRemoveWorktree(worktreePath, { allowDiskCleanup: false });
    }
  };

  const resolveTaskRepoPath = async (
    task: AgentTask,
    issueNumber: string,
    mode: "start" | "resume",
    repoSlot?: number | null,
    io?: {
      ensureGitWorktree?: (worktreePath: string) => Promise<void>;
      safeRemoveWorktree?: (worktreePath: string, opts?: { allowDiskCleanup?: boolean }) => Promise<void>;
    }
  ): Promise<ResolveTaskRepoPathResult> => {
    const ensureWorktree = io?.ensureGitWorktree ?? ensureGitWorktree;
    const removeWorktree = io?.safeRemoveWorktree ?? safeRemoveWorktree;

    const bestEffortResetQueued = async (reason: string): Promise<ResolveTaskRepoPathResult> => {
      console.warn(`[ralph:worker:${params.repo}] ${reason} (resetting task for retry)`);
      const patch: Record<string, string> = {
        "session-id": "",
        "worktree-path": "",
        "worker-id": "",
        "repo-slot": "",
        "daemon-id": "",
        "heartbeat-at": "",
        "watchdog-retries": "",
        "stall-retries": "",
      };

      // Best-effort: avoid throwing during resume path recovery.
      // Retry once to handle transient queue write failures.
      let updated = false;
      try {
        updated = await params.queue.updateTaskStatus(task, "queued", patch);
      } catch {
        // best-effort
      }
      if (!updated) {
        try {
          await params.queue.updateTaskStatus(task, "queued", patch);
        } catch {
          // best-effort
        }
      }

      // Keep the in-memory task consistent with the reset signal.
      try {
        task.status = "queued";
        for (const [k, v] of Object.entries(patch)) {
          (task as unknown as Record<string, unknown>)[k] = v;
        }
      } catch {
        // best-effort
      }

      return { kind: "reset", reason: `${reason} (task reset to queued)` };
    };

    const recorded = task["worktree-path"]?.trim();
    if (recorded) {
      if (isSameRepoRootPath(recorded)) {
        throw new Error(`Recorded worktree-path matches repo root; refusing to run in main checkout: ${recorded}`);
      }
      if (!isRepoWorktreePath(recorded)) {
        throw new Error(`Recorded worktree-path is outside managed worktrees dir: ${recorded}`);
      }
      if (isHealthyWorktreePath(recorded)) {
        return { kind: "ok", repoPath: recorded, worktreePath: recorded };
      }
      const reason = !existsSync(recorded)
        ? `Recorded worktree-path does not exist: ${recorded}`
        : `Recorded worktree-path is not a valid git worktree: ${recorded}`;

      if (mode === "resume") {
        const result = await bestEffortResetQueued(reason);
        await removeWorktree(recorded, { allowDiskCleanup: true });
        return result;
      }

      console.warn(`[ralph:worker:${params.repo}] ${reason} (recreating worktree)`);
      await removeWorktree(recorded, { allowDiskCleanup: true });
    }

    if (mode === "resume") {
      return await bestEffortResetQueued("Missing worktree-path for in-progress task; refusing to resume in main checkout");
    }

    const resolvedSlot = typeof repoSlot === "number" && Number.isFinite(repoSlot) ? repoSlot : 0;
    const taskKey = task._path || task._name || task.name;
    const worktreePath = buildWorktreePath({
      repo: params.repo,
      issueNumber,
      taskKey,
      repoSlot: resolvedSlot,
    });

    await ensureWorktree(worktreePath);
    await params.queue.updateTaskStatus(task, task.status === "in-progress" ? "in-progress" : "starting", {
      "worktree-path": worktreePath,
    });

    return { kind: "ok", repoPath: worktreePath, worktreePath };
  };

  const buildParentVerificationWorktreePath = (issueNumber: string): string => {
    return join(params.worktreesDir, repoKey, `parent-verify-${issueNumber}`);
  };

  return {
    isManagedWorktreePath,
    isRepoWorktreePath,
    isSameRepoRootPath,
    isHealthyWorktreePath,
    safeRemoveWorktree,
    ensureGitWorktree,
    getGitWorktrees,
    cleanupOrphanedWorktrees,
    cleanupWorktreesForTasks,
    resolveTaskRepoPath,
    buildParentVerificationWorktreePath,
  };
}
