import type { AgentTask } from "./types";
import { parseIssueRef } from "../github/issue-ref";
import { priorityRank } from "./priority";

export function normalizeTaskRef(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "").trim();
}

export function groupByRepo(tasks: AgentTask[]): Map<string, AgentTask[]> {
  const byRepo = new Map<string, AgentTask[]>();
  for (const task of tasks) {
    const existing = byRepo.get(task.repo);
    if (existing) {
      existing.push(task);
    } else {
      byRepo.set(task.repo, [task]);
    }
  }

  for (const [repo, repoTasks] of byRepo) {
    repoTasks.sort((a, b) => {
      const rankDelta = priorityRank(a.priority) - priorityRank(b.priority);
      if (rankDelta !== 0) return rankDelta;

      const aIssue = parseIssueRef(a.issue, a.repo)?.number ?? Number.POSITIVE_INFINITY;
      const bIssue = parseIssueRef(b.issue, b.repo)?.number ?? Number.POSITIVE_INFINITY;
      if (aIssue !== bIssue) return aIssue - bIssue;

      return a._path.localeCompare(b._path);
    });

    byRepo.set(repo, repoTasks);
  }

  return byRepo;
}
