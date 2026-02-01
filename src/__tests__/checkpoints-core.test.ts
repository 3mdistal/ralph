import { describe, expect, test } from "bun:test";

import {
  buildCheckpointState,
  onCheckpointReached,
  onPauseCleared,
  type CheckpointEffect,
} from "../checkpoints/core";

describe("checkpoint state machine", () => {
  test("emits checkpoint reached without pause", () => {
    const state = buildCheckpointState();
    const result = onCheckpointReached({
      checkpoint: "planned",
      state,
      pauseRequested: false,
      pauseAtCheckpoint: null,
      workerId: "worker-1",
    });

    expect(result.state.checkpointSeq).toBe(1);
    expect(result.state.lastCheckpoint).toBe("planned");
    const eventTypes = result.effects.filter((effect) => effect.kind === "emit").map((effect) => effect.eventType);
    expect(eventTypes).toEqual(["worker.checkpoint.reached"]);
  });

  test("emits pause requested/reached on edge", () => {
    const state = buildCheckpointState();
    const result = onCheckpointReached({
      checkpoint: "routed",
      state,
      pauseRequested: true,
      pauseAtCheckpoint: "routed",
      workerId: "worker-1",
    });

    const eventTypes = result.effects.filter((effect) => effect.kind === "emit").map((effect) => effect.eventType);
    expect(eventTypes).toEqual([
      "worker.checkpoint.reached",
      "worker.pause.requested",
      "worker.pause.reached",
    ]);
    expect(result.effects.some((effect) => effect.kind === "wait")).toBeTrue();
  });

  test("replay while paused only waits", () => {
    const state = buildCheckpointState({
      lastCheckpoint: "routed",
      checkpointSeq: 3,
      pausedAtCheckpoint: "routed",
      pauseRequested: true,
    });

    const result = onCheckpointReached({
      checkpoint: "routed",
      state,
      pauseRequested: true,
      pauseAtCheckpoint: "pr_ready",
      workerId: "worker-1",
    });

    expect(result.state.checkpointSeq).toBe(3);
    expect(result.effects).toEqual([{ kind: "wait", reason: "pause" } satisfies CheckpointEffect]);
  });

  test("does not pause until reaching pauseAtCheckpoint", () => {
    const state = buildCheckpointState();
    const result = onCheckpointReached({
      checkpoint: "planned",
      state,
      pauseRequested: true,
      pauseAtCheckpoint: "pr_ready",
      workerId: "worker-1",
    });

    expect(result.state.pauseRequested).toBeTrue();
    expect(result.state.pausedAtCheckpoint).toBeNull();
    expect(result.effects.some((effect) => effect.kind === "wait")).toBeFalse();

    const eventTypes = result.effects.filter((effect) => effect.kind === "emit").map((effect) => effect.eventType);
    expect(eventTypes).toEqual(["worker.checkpoint.reached", "worker.pause.requested"]);
  });

  test("clears pause when resume requested", () => {
    const state = buildCheckpointState({
      lastCheckpoint: "routed",
      checkpointSeq: 2,
      pausedAtCheckpoint: "routed",
      pauseRequested: true,
    });

    const result = onPauseCleared({
      state,
      pauseRequested: false,
      workerId: "worker-1",
    });

    const eventTypes = result.effects.filter((effect) => effect.kind === "emit").map((effect) => effect.eventType);
    expect(eventTypes).toEqual(["worker.pause.cleared"]);
    expect(result.state.pausedAtCheckpoint).toBeNull();
  });
});
