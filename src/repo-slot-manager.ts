export type RepoSlotReservation = {
  repo: string;
  slot: number;
  release: () => void;
};

export type RepoSlotAssignmentInput = {
  limit: number;
  inUse: ReadonlySet<number>;
  preferred?: number | null;
};

export function parseRepoSlot(value: unknown): number | null {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) return value;
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    return parsed;
  }
  return null;
}

export function parseRepoSlotFromWorktreePath(worktreePath?: string | null): number | null {
  if (!worktreePath) return null;
  const match = worktreePath.match(/(?:^|\/|\\)slot-(\d+)(?:\/|\\|$)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export function assignRepoSlot(input: RepoSlotAssignmentInput): number | null {
  const limit = input.limit;
  if (!Number.isInteger(limit) || limit <= 0) return null;
  const inUse = input.inUse;
  const preferred = typeof input.preferred === "number" ? input.preferred : null;
  if (preferred !== null && Number.isInteger(preferred) && preferred >= 0 && preferred < limit && !inUse.has(preferred)) {
    return preferred;
  }
  for (let slot = 0; slot < limit; slot += 1) {
    if (!inUse.has(slot)) return slot;
  }
  return null;
}

export class RepoSlotManager {
  private inUseByRepo = new Map<string, Set<number>>();
  private taskSlotsByRepo = new Map<string, Map<string, number>>();

  constructor(private getLimit: (repo: string) => number) {}

  reserveSlotForTask(
    repo: string,
    taskKey: string,
    opts?: { preferred?: number | null }
  ): RepoSlotReservation | null {
    const tasks = this.getTasks(repo);
    const existing = tasks.get(taskKey);
    if (existing !== undefined) {
      return this.buildReservation(repo, taskKey, existing);
    }

    const limit = this.getLimit(repo);
    const inUse = this.getInUse(repo);
    const slot = assignRepoSlot({ limit, inUse, preferred: opts?.preferred });
    if (slot === null) return null;
    inUse.add(slot);
    tasks.set(taskKey, slot);
    return this.buildReservation(repo, taskKey, slot);
  }

  markSlotForTask(repo: string, taskKey: string, slot: number): boolean {
    const limit = this.getLimit(repo);
    if (!Number.isInteger(limit) || limit <= 0) return false;
    if (!Number.isInteger(slot) || slot < 0 || slot >= limit) return false;
    const inUse = this.getInUse(repo);
    if (inUse.has(slot)) return false;
    inUse.add(slot);
    this.getTasks(repo).set(taskKey, slot);
    return true;
  }

  releaseSlotForTask(repo: string, taskKey: string): void {
    const tasks = this.taskSlotsByRepo.get(repo);
    if (!tasks) return;
    const slot = tasks.get(taskKey);
    if (slot === undefined) return;
    tasks.delete(taskKey);
    const inUse = this.inUseByRepo.get(repo);
    if (!inUse) return;
    inUse.delete(slot);
  }

  listInUse(repo: string): number[] {
    const inUse = this.inUseByRepo.get(repo);
    if (!inUse) return [];
    return Array.from(inUse.values()).sort((a, b) => a - b);
  }

  private getInUse(repo: string): Set<number> {
    let inUse = this.inUseByRepo.get(repo);
    if (!inUse) {
      inUse = new Set<number>();
      this.inUseByRepo.set(repo, inUse);
    }
    return inUse;
  }

  private getTasks(repo: string): Map<string, number> {
    let tasks = this.taskSlotsByRepo.get(repo);
    if (!tasks) {
      tasks = new Map<string, number>();
      this.taskSlotsByRepo.set(repo, tasks);
    }
    return tasks;
  }

  private buildReservation(repo: string, taskKey: string, slot: number): RepoSlotReservation {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.releaseSlotForTask(repo, taskKey);
    };
    return { repo, slot, release };
  }
}
