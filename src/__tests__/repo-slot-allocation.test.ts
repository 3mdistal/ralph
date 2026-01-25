import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { __resetConfigForTests, loadConfig } from "../config";
import type { AgentTask } from "../queue-backend";
import { getRalphConfigTomlPath } from "../paths";
import { RepoWorker } from "../worker";

let homeDir: string;
let priorHome: string | undefined;

async function writeToml(lines: string[]): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(getRalphConfigTomlPath(), lines.join("\n"), "utf8");
}

function taskStub(id: string, extra?: Partial<AgentTask>): AgentTask {
  return {
    _path: `orchestration/tasks/${id}`,
    name: `Task ${id}`,
    repo: "demo/repo",
    issue: "demo/repo#1",
    status: "queued",
    ...extra,
  } as AgentTask;
}

describe("repo slot allocation", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    await writeToml(["repos = [{ name = \"demo/repo\", concurrencySlots = 2 }]"]);
    __resetConfigForTests();
    loadConfig();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  test("allocates lowest free slot", () => {
    const worker = new RepoWorker("demo/repo", "/tmp");
    const taskA = taskStub("a");
    const taskB = taskStub("b");
    const taskC = taskStub("c");

    const slotA = (worker as any).allocateRepoSlot(taskA, null);
    const slotB = (worker as any).allocateRepoSlot(taskB, null);
    expect(slotA).toBe(0);
    expect(slotB).toBe(1);

    (worker as any).releaseRepoSlot(slotA, taskA);
    const slotC = (worker as any).allocateRepoSlot(taskC, null);
    expect(slotC).toBe(0);
  });

  test("reuses persisted slot for the same task", () => {
    const worker = new RepoWorker("demo/repo", "/tmp");
    const taskA = taskStub("a", { "repo-slot": "1" } as Partial<AgentTask>);

    (worker as any).seedRepoSlotsInUse([taskA]);
    const slot = (worker as any).allocateRepoSlot(taskA, 1);
    expect(slot).toBe(1);
  });
});
