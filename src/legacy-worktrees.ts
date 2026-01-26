import { resolve } from "path";

export type LegacyWorktreeWarningInput = {
  repo: string;
  repoPath: string;
  devDir: string;
  managedRoot: string;
  legacyPaths: string[];
};

const MAX_LISTED_LEGACY = 10;

function formatPathList(paths: string[]): string[] {
  const normalized = Array.from(new Set(paths)).sort();
  if (normalized.length <= MAX_LISTED_LEGACY) return normalized;
  const head = normalized.slice(0, MAX_LISTED_LEGACY);
  return [...head, `(+${normalized.length - MAX_LISTED_LEGACY} more)`];
}

export function formatLegacyWorktreeWarning(input: LegacyWorktreeWarningInput): string {
  const legacyList = formatPathList(input.legacyPaths);
  const managedRoot = resolve(input.managedRoot);
  const devDir = resolve(input.devDir);

  const lines = [
    `[ralph:worker:${input.repo}] Legacy worktrees detected outside ${managedRoot}.`,
    `Repo: ${input.repo}`,
    `Repo path: ${input.repoPath}`,
    `Legacy base dir: ${devDir}`,
    "Legacy paths:",
    ...legacyList.map((path) => `  ${path}`),
    "",
    "Ralph will not auto-delete legacy worktrees.",
    "",
    "Review and clean safely:",
    `  ralph worktrees legacy --repo ${input.repo} --dry-run --action cleanup`,
    "",
    "To clean safe worktrees:",
    `  ralph worktrees legacy --repo ${input.repo} --action cleanup`,
    "",
    "Optional migrate (safe worktrees only):",
    `  ralph worktrees legacy --repo ${input.repo} --action migrate`,
  ];

  return lines.join("\n");
}
