import { resolve, sep } from "path";

export interface GitWorktreeEntry {
  worktreePath: string;
  head?: string;
  branch?: string;
  detached?: boolean;
}

export function isPathUnderDir(path: string, baseDir: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedBase = resolve(baseDir);
  return resolvedPath === resolvedBase || resolvedPath.startsWith(`${resolvedBase}${sep}`);
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

      if (entry.worktreePath.includes(`worktree-${issue}`)) score += 100;
      if (entry.worktreePath.includes(`-${issue}`)) score += 25;
      if (branch?.endsWith(`-${issue}`)) score += 75;
      if (branch?.includes(issue)) score += 10;

      if (entry.detached) score -= 100;
      if (branch && deprioritize.has(branch)) score -= 50;

      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.entry ?? null;
}
