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
    "Ralph will not auto-delete or auto-migrate legacy worktrees.",
    "",
    "Review and clean safely (manual):",
    `  git -C ${input.repoPath} worktree list`,
    "",
    "To remove a legacy worktree after verifying it is safe:",
    `  git -C ${input.repoPath} worktree remove <legacy-path>`,
  ];

  return lines.join("\n");
}
