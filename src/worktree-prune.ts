import { $ } from "bun";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import { relative, resolve } from "path";

import { isLegacyWorktreePath, isPathUnderDir } from "./git-worktree";
import { buildWorktreePath } from "./worktree-paths";

export type WorktreePruneSafety = {
  safe: boolean;
  reason: "ok" | "missing-path" | "outside-managed-root" | "repo-root" | "legacy-worktree" | "invalid-layout";
  normalizedPath: string | null;
};

export type WorktreePruneResult = {
  attempted: boolean;
  pruned: boolean;
  safety: WorktreePruneSafety;
  gitRemoved: boolean;
  error?: string;
};

function isValidManagedLayout(path: string, managedRoot: string): boolean {
  const rel = relative(resolve(managedRoot), resolve(path));
  if (!rel || rel.startsWith("..")) return false;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 4) return false;
  return /^slot-\d+$/.test(segments[1] ?? "");
}

export function evaluateWorktreePruneSafety(params: {
  worktreePath?: string | null;
  managedRoot: string;
  repoPath: string;
  devDir: string;
}): WorktreePruneSafety {
  const rawPath = params.worktreePath?.trim() ?? "";
  if (!rawPath) {
    return { safe: false, reason: "missing-path", normalizedPath: null };
  }

  const normalizedPath = resolve(rawPath);
  const managedRoot = resolve(params.managedRoot);
  const repoPath = resolve(params.repoPath);

  if (!isPathUnderDir(normalizedPath, managedRoot)) {
    return { safe: false, reason: "outside-managed-root", normalizedPath };
  }
  if (normalizedPath === repoPath) {
    return { safe: false, reason: "repo-root", normalizedPath };
  }
  if (isLegacyWorktreePath(normalizedPath, { devDir: params.devDir, managedRoot })) {
    return { safe: false, reason: "legacy-worktree", normalizedPath };
  }
  if (!isValidManagedLayout(normalizedPath, managedRoot)) {
    return { safe: false, reason: "invalid-layout", normalizedPath };
  }

  return { safe: true, reason: "ok", normalizedPath };
}

export async function pruneManagedWorktreeBestEffort(params: {
  repoPath: string;
  worktreePath?: string | null;
  managedRoot: string;
  devDir: string;
}): Promise<WorktreePruneResult> {
  const safety = evaluateWorktreePruneSafety(params);
  if (!safety.safe || !safety.normalizedPath) {
    return { attempted: false, pruned: false, safety, gitRemoved: false };
  }

  const targetPath = safety.normalizedPath;
  let gitRemoved = false;
  let lastError = "";

  try {
    await $`git worktree remove --force ${targetPath}`.cwd(params.repoPath).quiet();
    gitRemoved = true;
  } catch (error: any) {
    lastError = error?.message ?? String(error);
  }

  try {
    if (existsSync(targetPath)) {
      await rm(targetPath, { recursive: true, force: true });
    }
    return { attempted: true, pruned: true, safety, gitRemoved, ...(lastError ? { error: lastError } : {}) };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return {
      attempted: true,
      pruned: gitRemoved,
      safety,
      gitRemoved,
      error: lastError ? `${lastError}; ${message}` : message,
    };
  }
}

function parseRepoSlot(slot: string | null | undefined): number | null {
  if (typeof slot !== "string") return null;
  const trimmed = slot.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export function computeTaskWorktreeCandidates(params: {
  repo: string;
  issueNumber: number | null;
  taskPath: string;
  repoSlot: string | null | undefined;
  recordedWorktreePath?: string | null;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const normalized = resolve(trimmed);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  add(params.recordedWorktreePath);

  if (typeof params.issueNumber === "number" && Number.isFinite(params.issueNumber)) {
    const parsedSlot = parseRepoSlot(params.repoSlot);
    if (typeof parsedSlot === "number") {
      add(
        buildWorktreePath({
          repo: params.repo,
          issueNumber: String(params.issueNumber),
          taskKey: params.taskPath,
          repoSlot: parsedSlot,
        })
      );
    }
  }

  return out;
}
