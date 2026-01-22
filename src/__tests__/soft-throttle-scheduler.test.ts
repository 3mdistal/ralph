import { describe, expect, test } from "bun:test";
import { Semaphore } from "../semaphore";
import { startQueuedTasks } from "../scheduler";

type TestTask = { repo: string; key: string };

function groupByRepo(tasks: TestTask[]): Map<string, TestTask[]> {
  const by = new Map<string, TestTask[]>();
  for (const t of tasks) {
    const existing = by.get(t.repo);
    if (existing) existing.push(t);
    else by.set(t.repo, [t]);
  }
  return by;
}

describe("soft throttle scheduler gate", () => {
  test("does not start any new tasks when soft-throttled", async () => {
    const started: TestTask[] = [];

    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(1);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const startedCount = await startQueuedTasks<TestTask>({
      gate: "soft-throttled",
      tasks: [{ repo: "a", key: "1" }, { repo: "b", key: "2" }],
      inFlightTasks: new Set<string>(),
      getTaskKey: (t) => t.key,
      groupByRepo,
      globalSemaphore: new Semaphore(10),
      getRepoSemaphore,
      rrCursor: { value: 0 },
      shouldLog: () => false,
      log: () => {},
      startTask: ({ task }) => {
        started.push(task);
        return true;
      },
    });

    expect(startedCount).toBe(0);
    expect(started.length).toBe(0);
  });

  test("starts tasks normally when running", async () => {
    const started: TestTask[] = [];

    const perRepo = new Map<string, Semaphore>();
    const getRepoSemaphore = (repo: string) => {
      let sem = perRepo.get(repo);
      if (!sem) {
        sem = new Semaphore(1);
        perRepo.set(repo, sem);
      }
      return sem;
    };

    const startedCount = await startQueuedTasks<TestTask>({
      gate: "running",
      tasks: [{ repo: "a", key: "1" }, { repo: "b", key: "2" }],
      inFlightTasks: new Set<string>(),
      getTaskKey: (t) => t.key,
      groupByRepo,
      globalSemaphore: new Semaphore(10),
      getRepoSemaphore,
      rrCursor: { value: 0 },
      shouldLog: () => false,
      log: () => {},
      startTask: ({ task }) => {
        started.push(task);
        return true;
      },
    });

    expect(startedCount).toBeGreaterThan(0);
    expect(started.length).toBe(startedCount);
  });
});
