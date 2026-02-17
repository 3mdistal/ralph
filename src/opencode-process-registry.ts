import type { ChildProcess } from "child_process";

export type OpencodeRun = {
  kind?: "run" | "server";
  pid: number;
  pgid: number;
  useProcessGroup: boolean;
  startedAt: number;
  repo?: string;
  issue?: string;
  taskName?: string;
  sessionId?: string;
  command?: string;
};

const runs = new Map<number, OpencodeRun>();

export function registerOpencodeRun(
  proc: ChildProcess,
  meta: Omit<OpencodeRun, "pid" | "pgid" | "startedAt"> & { startedAt?: number; useProcessGroup: boolean }
): OpencodeRun | null {
  if (!proc.pid) return null;
  const record: OpencodeRun = {
    kind: meta.kind ?? "run",
    pid: proc.pid,
    pgid: proc.pid,
    startedAt: meta.startedAt ?? Date.now(),
    useProcessGroup: meta.useProcessGroup,
    repo: meta.repo,
    issue: meta.issue,
    taskName: meta.taskName,
    sessionId: meta.sessionId,
    command: meta.command,
  };
  runs.set(record.pgid, record);
  return record;
}

export function updateOpencodeRun(pgid: number, updates: Partial<OpencodeRun>): void {
  const record = runs.get(pgid);
  if (!record) return;
  Object.assign(record, updates);
}

export function unregisterOpencodeRun(pgid: number): void {
  runs.delete(pgid);
}

function listOpencodeRuns(): OpencodeRun[] {
  return Array.from(runs.values());
}

export async function terminateOpencodeRuns(options?: {
  graceMs?: number;
  processKill?: typeof process.kill;
}): Promise<{ total: number; remaining: number }> {
  const processKill = options?.processKill ?? process.kill;
  const graceMs = options?.graceMs ?? 5000;
  const snapshot = listOpencodeRuns();

  if (snapshot.length === 0) return { total: 0, remaining: 0 };

  for (const run of snapshot) {
    try {
      processKill(run.useProcessGroup ? -run.pgid : run.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  if (graceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
  }

  const remaining = snapshot.filter((run) => isRunAlive(run, processKill));
  if (remaining.length > 0) {
    for (const run of remaining) {
      try {
        processKill(run.useProcessGroup ? -run.pgid : run.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  return { total: snapshot.length, remaining: remaining.length };
}

export function __resetOpencodeRunsForTests(): void {
  runs.clear();
}

function isRunAlive(run: OpencodeRun, processKill: typeof process.kill): boolean {
  try {
    processKill(run.useProcessGroup ? -run.pgid : run.pid, 0);
    return true;
  } catch {
    return false;
  }
}
