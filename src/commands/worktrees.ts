import { $ } from "bun";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { basename, join } from "path";

import { getConfig, getRepoBotBranch, getRepoPath } from "../config";
import {
  detectLegacyWorktrees,
  parseGitWorktreeListPorcelain,
  stripHeadsRef,
  type GitWorktreeEntry,
} from "../git-worktree";
import { getRalphWorktreesDir } from "../paths";
import { sanitizeNoteName } from "../util/sanitize-note-name";
import {
  decideLegacyWorktreeSafety,
  type LegacyWorktreeSafetyDecision,
  type LegacyWorktreeSafetySnapshot,
} from "../legacy-worktree-safety";

type LegacyAction = "cleanup" | "migrate";

type LegacyWorktreeSnapshot = LegacyWorktreeSafetySnapshot & {
  entry: GitWorktreeEntry;
};

const ACTIONS: LegacyAction[] = ["cleanup", "migrate"];

function parseLegacyArgs(args: string[]): {
  repo: string;
  action: LegacyAction | null;
  dryRun: boolean;
  help: boolean;
  error?: string;
} {
  let repo = "";
  let action: LegacyAction | null = null;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--repo") {
      repo = args[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--action") {
      const value = args[i + 1] ?? "";
      if (ACTIONS.includes(value as LegacyAction)) {
        action = value as LegacyAction;
      } else {
        return { repo, action, dryRun, help, error: `Invalid --action value: ${value}` };
      }
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
  }

  return { repo, action, dryRun, help };
}

function formatLegacyUsage(): string {
  return [
    "Usage:",
    "  ralph worktrees legacy --repo <owner/repo> --action <cleanup|migrate> [--dry-run]",
    "",
    "Options:",
    "  --repo <owner/repo>         Target repository",
    "  --action <cleanup|migrate>  Cleanup or migrate legacy worktrees",
    "  --dry-run                   Report actions without making changes",
  ].join("\n");
}

async function listGitWorktrees(repoPath: string): Promise<GitWorktreeEntry[]> {
  try {
    const result = await $`git worktree list --porcelain`.cwd(repoPath).quiet();
    return parseGitWorktreeListPorcelain(result.stdout.toString());
  } catch {
    return [];
  }
}

async function resolveMainlineRef(repoPath: string, repoName: string): Promise<string | null> {
  const botBranch = getRepoBotBranch(repoName);
  const candidates = [botBranch, "main", "master"].filter(Boolean);
  const seen = new Set<string>();

  for (const ref of candidates) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    try {
      await $`git rev-parse --verify ${ref}`.cwd(repoPath).quiet();
      return ref;
    } catch {
      // continue
    }
  }

  return null;
}

async function resolveLegacySnapshot(params: {
  entry: GitWorktreeEntry;
  repoPath: string;
  repoName: string;
  baseRef: string | null;
}): Promise<LegacyWorktreeSnapshot> {
  const detached = Boolean(params.entry.detached);
  const branchRef = params.entry.branch?.trim() || null;
  const baseRef = params.baseRef;
  const baseRefAvailable = Boolean(baseRef);

  const validWorktree =
    Boolean(params.entry.worktreePath) &&
    existsSync(params.entry.worktreePath) &&
    existsSync(join(params.entry.worktreePath, ".git"));

  if (!validWorktree) {
    return {
      entry: params.entry,
      branchRef,
      detached,
      dirty: false,
      baseRef,
      baseRefAvailable,
      mergedIntoBase: false,
      validWorktree: false,
      error: "worktree path missing or not a valid git worktree",
    };
  }

  if (!branchRef || detached) {
    return {
      entry: params.entry,
      branchRef,
      detached,
      dirty: false,
      baseRef,
      baseRefAvailable,
      mergedIntoBase: false,
      validWorktree: true,
      error: "detached HEAD or missing branch",
    };
  }

  if (!baseRef) {
    return {
      entry: params.entry,
      branchRef,
      detached,
      dirty: false,
      baseRef,
      baseRefAvailable,
      mergedIntoBase: false,
      validWorktree: true,
      error: "base ref not found; run git fetch --all --prune",
    };
  }

  let dirty = false;
  try {
    const status = await $`git status --porcelain`.cwd(params.entry.worktreePath).quiet();
    dirty = Boolean(status.stdout.toString().trim());
  } catch (e: any) {
    return {
      entry: params.entry,
      branchRef,
      detached,
      dirty: false,
      baseRef,
      baseRefAvailable,
      mergedIntoBase: false,
      validWorktree: true,
      error: `git status failed: ${e?.message ?? String(e)}`,
    };
  }

  let mergedIntoBase = false;
  try {
    await $`git merge-base --is-ancestor ${branchRef} ${baseRef}`.cwd(params.repoPath).quiet();
    mergedIntoBase = true;
  } catch {
    mergedIntoBase = false;
  }

  return {
    entry: params.entry,
    branchRef,
    detached,
    dirty,
    baseRef,
    baseRefAvailable,
    mergedIntoBase,
    validWorktree: true,
  };
}

function formatLegacySummary(params: {
  repo: string;
  action: LegacyAction;
  dryRun: boolean;
  snapshots: { snapshot: LegacyWorktreeSnapshot; decision: LegacyWorktreeSafetyDecision }[];
}): string {
  const lines: string[] = [];
  lines.push(`Legacy worktrees for ${params.repo}:`);
  lines.push(`Action: ${params.action}${params.dryRun ? " (dry-run)" : ""}`);

  for (const { snapshot, decision } of params.snapshots) {
    const branch = snapshot.branchRef ? stripHeadsRef(snapshot.branchRef) : null;
    const status = decision.ok ? "safe" : `blocked (${decision.reason})`;
    lines.push(`- ${snapshot.entry.worktreePath} | ${branch ?? "(unknown)"} | ${status}`);
  }

  return lines.join("\n");
}

async function moveLegacyWorktree(params: {
  repoPath: string;
  worktreePath: string;
  targetBase: string;
}): Promise<string> {
  const baseName = basename(params.worktreePath);
  let target = join(params.targetBase, baseName);
  let counter = 1;
  while (existsSync(target)) {
    target = join(params.targetBase, `${baseName}-${counter}`);
    counter += 1;
  }

  await mkdir(params.targetBase, { recursive: true });
  await $`git worktree move ${params.worktreePath} ${target}`.cwd(params.repoPath).quiet();
  return target;
}

export async function runWorktreesCommand(args: string[]): Promise<void> {
  const subcommand = args[1];
  if (subcommand !== "legacy") {
    console.error("Usage: ralph worktrees legacy --repo <owner/repo> --action <cleanup|migrate> [--dry-run]");
    process.exit(1);
  }

  const parsed = parseLegacyArgs(args.slice(2));
  if (parsed.help) {
    console.log(formatLegacyUsage());
    process.exit(0);
  }

  if (parsed.error) {
    console.error(parsed.error);
    console.error(formatLegacyUsage());
    process.exit(1);
  }

  if (!parsed.repo.trim()) {
    console.error("Missing required --repo <owner/repo>.");
    console.error(formatLegacyUsage());
    process.exit(1);
  }

  if (!parsed.action) {
    console.error("Missing required --action <cleanup|migrate>.");
    console.error(formatLegacyUsage());
    process.exit(1);
  }

  const action = parsed.action ?? "cleanup";
  const repoName = parsed.repo.trim();
  const repoPath = getRepoPath(repoName);
  if (!existsSync(repoPath)) {
    console.error(`Repo path not found: ${repoPath}`);
    process.exit(1);
  }

  const config = getConfig();
  const managedRoot = getRalphWorktreesDir();
  const entries = await listGitWorktrees(repoPath);
  const legacyEntries = detectLegacyWorktrees(entries, {
    devDir: config.devDir,
    managedRoot,
  });

  if (legacyEntries.length === 0) {
    console.log(`No legacy worktrees detected for ${repoName}.`);
    process.exit(0);
  }

  const baseRef = await resolveMainlineRef(repoPath, repoName);
  const snapshots = await Promise.all(
    legacyEntries.map(async (entry) => {
      const snapshot = await resolveLegacySnapshot({
        entry,
        repoPath,
        repoName,
        baseRef,
      });
      const decision = decideLegacyWorktreeSafety(snapshot);
      return { snapshot, decision };
    })
  );

  console.log(
    formatLegacySummary({
      repo: repoName,
      action,
      dryRun: parsed.dryRun,
      snapshots,
    })
  );

  if (parsed.dryRun) {
    process.exit(0);
  }

  const safe = snapshots.filter((entry) => entry.decision.ok);
  if (safe.length === 0) {
    console.error("No safe legacy worktrees to process.");
    process.exit(1);
  }

  const errors: string[] = [];
  if (action === "cleanup") {
    for (const { snapshot } of safe) {
      try {
        await $`git worktree remove ${snapshot.entry.worktreePath}`.cwd(repoPath).quiet();
        console.log(`Removed ${snapshot.entry.worktreePath}`);
      } catch (e: any) {
        errors.push(`Failed to remove ${snapshot.entry.worktreePath}: ${e?.message ?? String(e)}`);
      }
    }
  }

  if (action === "migrate") {
    const repoKey = sanitizeNoteName(repoName);
    const targetBase = join(managedRoot, repoKey, "legacy");
    for (const { snapshot } of safe) {
      try {
        const target = await moveLegacyWorktree({
          repoPath,
          worktreePath: snapshot.entry.worktreePath,
          targetBase,
        });
        console.log(`Moved ${snapshot.entry.worktreePath} -> ${target}`);
      } catch (e: any) {
        errors.push(`Failed to move ${snapshot.entry.worktreePath}: ${e?.message ?? String(e)}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(err);
    process.exit(1);
  }

  process.exit(0);
}
