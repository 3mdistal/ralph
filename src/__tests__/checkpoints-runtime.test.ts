import { describe, expect, test } from "bun:test";

import { applyCheckpointReached } from "../checkpoints/runtime";
import { buildCheckpointState, type CheckpointState } from "../checkpoints/core";

describe("checkpoint runtime", () => {
  test("applies pause cycle with ordered events", async () => {
    let pauseRequested = true;
    const persisted: CheckpointState[] = [];
    const emitted: string[] = [];

    await applyCheckpointReached({
      checkpoint: "planned",
      pauseAtCheckpoint: null,
      state: buildCheckpointState(),
      context: {
        workerId: "worker-1",
        repo: "3mdistal/ralph",
        taskId: "orchestration/tasks/test.md",
        sessionId: "ses_test",
      },
      store: {
        persist: async (state) => {
          persisted.push(state);
        },
      },
      pauseSource: {
        isPauseRequested: () => pauseRequested,
        waitUntilCleared: async () => {
          pauseRequested = false;
        },
      },
      emitter: {
        emit: (event, _key) => {
          emitted.push(event.type);
        },
      },
    });

    expect(emitted).toEqual([
      "worker.checkpoint.reached",
      "worker.pause.requested",
      "worker.pause.reached",
      "worker.pause.cleared",
    ]);
    expect(persisted.length).toBe(2);
    expect(persisted[0]?.pausedAtCheckpoint).toBe("planned");
    expect(persisted[1]?.pausedAtCheckpoint).toBeNull();
  });

  test("does not wait when pauseAtCheckpoint does not match", async () => {
    let pauseRequested = true;
    const persisted: CheckpointState[] = [];
    const emitted: string[] = [];

    await applyCheckpointReached({
      checkpoint: "planned",
      pauseAtCheckpoint: "pr_ready",
      state: buildCheckpointState(),
      context: {
        workerId: "worker-1",
      },
      store: {
        persist: async (state) => {
          persisted.push(state);
        },
      },
      pauseSource: {
        isPauseRequested: () => pauseRequested,
        waitUntilCleared: async () => {
          throw new Error("waitUntilCleared should not be called");
        },
      },
      emitter: {
        emit: (event, _key) => {
          emitted.push(event.type);
        },
      },
    });

    expect(emitted).toEqual(["worker.checkpoint.reached", "worker.pause.requested"]);
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.pausedAtCheckpoint).toBeNull();
    expect(persisted[0]?.pauseRequested).toBeTrue();

    // Ensure the pause flag wasn't mutated by runtime.
    expect(pauseRequested).toBeTrue();
  });
});
