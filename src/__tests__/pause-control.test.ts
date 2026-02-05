import { describe, expect, test } from "bun:test";

import type { AgentTask } from "../queue-backend";
import { createPauseControl, recordCheckpoint } from "../worker/pause-control";

describe("pause control", () => {
  test("reads pause control snapshot with checkpoint validation", () => {
    let state = { pauseRequested: true, pauseAtCheckpoint: "planned" };
    const pause = createPauseControl({
      readControlStateSnapshot: () => state,
      defaults: {},
      isRalphCheckpoint: (value) => value === "planned",
    });

    const snapshot = pause.readPauseControl();
    expect(snapshot.pauseRequested).toBe(true);
    expect(snapshot.pauseAtCheckpoint).toBe("planned");

    state = { pauseRequested: true, pauseAtCheckpoint: "not-a-checkpoint" };
    const fallback = pause.readPauseControl();
    expect(fallback.pauseAtCheckpoint).toBe(null);
  });

  test("waitForPauseCleared uses backoff with jitter", async () => {
    let pauseRequested = true;
    const delays: number[] = [];
    const pause = createPauseControl({
      readControlStateSnapshot: () => ({ pauseRequested }),
      defaults: {},
      isRalphCheckpoint: () => false,
      jitter: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length >= 3) pauseRequested = false;
      },
    });

    await pause.waitForPauseCleared();

    expect(delays).toEqual([250, 400, 640]);
  });

  test("recordCheckpoint persists patch with status preserved", async () => {
    const task = {
      _path: "task/path",
      _name: "task-name",
      type: "agent-task",
      "creation-date": "2026-02-04",
      scope: "scope",
      issue: "3mdistal/ralph#562",
      repo: "3mdistal/ralph",
      status: "in-progress",
      name: "task",
    } satisfies AgentTask;

    let patched: { status: AgentTask["status"]; patch: Record<string, string> } | null = null;
    const pauseControl = createPauseControl({
      readControlStateSnapshot: () => ({ pauseRequested: false }),
      defaults: {},
      isRalphCheckpoint: () => false,
    });

    await recordCheckpoint({
      task,
      checkpoint: "planned",
      workerId: "worker#task",
      repo: "3mdistal/ralph",
      pauseControl,
      updateTaskStatus: async (_task, status, patch) => {
        patched = { status, patch };
        return true;
      },
      applyTaskPatch: (_task, status, patch) => {
        patched = { status, patch };
      },
      emitter: {
        emit: () => undefined,
      },
    });

    expect(patched?.status).toBe("in-progress");
    expect(patched?.patch).toMatchObject({
      checkpoint: "planned",
      "checkpoint-seq": "1",
      "pause-requested": "false",
      "paused-at-checkpoint": "",
    });
  });

  test("recordCheckpoint emits even when persistence fails", async () => {
    const task = {
      _path: "task/path",
      _name: "task-name",
      type: "agent-task",
      "creation-date": "2026-02-04",
      scope: "scope",
      issue: "3mdistal/ralph#562",
      repo: "3mdistal/ralph",
      status: "in-progress",
      name: "task",
    } satisfies AgentTask;

    const emitted: string[] = [];
    const pauseControl = createPauseControl({
      readControlStateSnapshot: () => ({ pauseRequested: false }),
      defaults: {},
      isRalphCheckpoint: () => false,
    });

    await recordCheckpoint({
      task,
      checkpoint: "planned",
      workerId: "worker#task",
      repo: "3mdistal/ralph",
      pauseControl,
      updateTaskStatus: async () => false,
      applyTaskPatch: () => undefined,
      emitter: {
        emit: (event) => emitted.push(event.type),
      },
      log: () => undefined,
    });

    expect(emitted).toContain("worker.checkpoint.reached");
  });
});
