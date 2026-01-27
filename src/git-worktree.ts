import { basename, resolve, sep } from "path";

export interface GitWorktreeEntry {
  worktreePath: string;
  head?: string;
  branch?: string;
  detached?: boolean;
}

export type LegacyWorktreeOptions = {
  devDir: string;
  managedRoot: string;
};

export function isPathUnderDir(path: string, baseDir: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedBase = resolve(baseDir);
  return resolvedPath === resolvedBase || resolvedPath.startsWith(`${resolvedBase}${sep}`);
}

export function isLegacyWorktreePath(path: string, options: LegacyWorktreeOptions): boolean {
  if (!path) return false;
  if (isPathUnderDir(path, options.managedRoot)) return false;
  if (!isPathUnderDir(path, options.devDir)) return false;
  const name = basename(path);
  return /^worktree-issue-\d+(?:-.*)?$/.test(name) || /^worktree-\d+(?:-.*)?$/.test(name);
}

export function detectLegacyWorktrees(
  entries: GitWorktreeEntry[],
  options: LegacyWorktreeOptions
): GitWorktreeEntry[] {
  return entries.filter((entry) => isLegacyWorktreePath(entry.worktreePath, options));
}

export function parseGitWorktreeListPorcelain(output: string): GitWorktreeEntry[] {
  const lines = output.split(/\r?\n/);
  const entries: GitWorktreeEntry[] = [];

  let current: Partial<GitWorktreeEntry> | null = null;

  const flush = () => {
    if (!current?.worktreePath) return;
    entries.push(current as GitWorktreeEntry);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    if (line.startsWith("worktree ")) {
      flush();
      current = { worktreePath: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
      continue;
    }

    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
      continue;
    }

    if (line === "detached") {
      current.detached = true;
      continue;
    }
  }

  flush();
  return entries;
}

export function stripHeadsRef(ref: string | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasIssueSegment(path: string, issue: string): boolean {
  const escaped = escapeRegExp(issue);
  const segment = new RegExp(`(^|[\\/])${escaped}([\\/]|$)`);
  return segment.test(path);
}

function hasIssueToken(value: string, issue: string): boolean {
  const escaped = escapeRegExp(issue);
  const token = new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`);
  return token.test(value);
}

function hasLegacyIssuePrefix(path: string, prefix: string, issue: string): boolean {
  const escapedPrefix = escapeRegExp(prefix);
  const escapedIssue = escapeRegExp(issue);
  const pattern = new RegExp(`${escapedPrefix}${escapedIssue}(?:$|[^0-9])`);
  return pattern.test(path);
}

export function pickWorktreeForIssue(
  entries: GitWorktreeEntry[],
  issueNumber: string,
  options?: { deprioritizeBranches?: string[] }
): GitWorktreeEntry | null {
  const issue = String(issueNumber).trim();
  if (!issue) return null;

  const deprioritize = new Set(options?.deprioritizeBranches ?? []);

  const scored = entries
    .map((entry) => {
      const branch = stripHeadsRef(entry.branch);
      let score = 0;

      if (hasIssueSegment(entry.worktreePath, issue)) score += 125;
      if (hasLegacyIssuePrefix(entry.worktreePath, "worktree-issue-", issue)) score += 110;
      if (hasLegacyIssuePrefix(entry.worktreePath, "worktree-", issue)) score += 95;
      if (branch?.endsWith(`-${issue}`)) score += 75;
      if (branch && hasIssueToken(branch, issue)) score += 10;

      if (entry.detached) score -= 100;
      if (branch && deprioritize.has(branch)) score -= 50;

      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.entry ?? null;
}
