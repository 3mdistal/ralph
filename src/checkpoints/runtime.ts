import type { RalphCheckpoint, RalphEvent } from "../dashboard/events";
import { buildRalphEvent } from "../dashboard/events";

import {
  onCheckpointReached,
  onPauseCleared,
  type CheckpointEffect,
  type CheckpointState,
} from "./core";

export type CheckpointContext = {
  workerId: string;
  repo?: string;
  taskId?: string;
  sessionId?: string;
};

export type CheckpointStore = {
  persist: (state: CheckpointState) => Promise<void>;
};

export type PauseSource = {
  isPauseRequested: () => boolean;
  waitUntilCleared: (opts?: { signal?: AbortSignal }) => Promise<void>;
};

export type CheckpointEventEmitter = {
  emit: (event: RalphEvent, idempotencyKey: string) => void;
  hasEmitted?: (idempotencyKey: string) => boolean;
};

export async function applyCheckpointReached(params: {
  checkpoint: RalphCheckpoint;
  state: CheckpointState;
  context: CheckpointContext;
  store: CheckpointStore;
  pauseSource: PauseSource;
  emitter: CheckpointEventEmitter;
  signal?: AbortSignal;
}): Promise<CheckpointState> {
  const pauseRequested = params.pauseSource.isPauseRequested();
  const result = onCheckpointReached({
    checkpoint: params.checkpoint,
    state: params.state,
    pauseRequested,
    workerId: params.context.workerId,
  });

  await applyCheckpointEffects({
    effects: result.effects,
    context: params.context,
    store: params.store,
    emitter: params.emitter,
  });

  if (result.effects.some((effect) => effect.kind === "wait")) {
    await params.pauseSource.waitUntilCleared({ signal: params.signal });

    const cleared = onPauseCleared({
      state: result.state,
      pauseRequested: params.pauseSource.isPauseRequested(),
      workerId: params.context.workerId,
    });

    await applyCheckpointEffects({
      effects: cleared.effects,
      context: params.context,
      store: params.store,
      emitter: params.emitter,
    });

    return cleared.state;
  }

  return result.state;
}

async function applyCheckpointEffects(params: {
  effects: CheckpointEffect[];
  context: CheckpointContext;
  store: CheckpointStore;
  emitter: CheckpointEventEmitter;
}): Promise<void> {
  for (const effect of params.effects) {
    if (effect.kind === "persist") {
      await params.store.persist(effect.state);
      continue;
    }

    if (effect.kind === "emit") {
      if (params.emitter.hasEmitted?.(effect.idempotencyKey)) continue;

      const event = buildRalphEvent({
        type: effect.eventType,
        level: effect.eventType.includes("pause") ? "info" : "info",
        ...(params.context.workerId ? { workerId: params.context.workerId } : {}),
        ...(params.context.repo ? { repo: params.context.repo } : {}),
        ...(params.context.taskId ? { taskId: params.context.taskId } : {}),
        ...(params.context.sessionId ? { sessionId: params.context.sessionId } : {}),
        data: buildEventData(effect),
      });

      params.emitter.emit(event, effect.idempotencyKey);
    }
  }
}

function buildEventData(effect: Extract<CheckpointEffect, { kind: "emit" }>): RalphEvent["data"] {
  switch (effect.eventType) {
    case "worker.checkpoint.reached":
      return { checkpoint: effect.checkpoint! };
    case "worker.pause.reached":
      return effect.checkpoint ? { checkpoint: effect.checkpoint } : {};
    case "worker.pause.requested":
      return {};
    case "worker.pause.cleared":
      return {};
    default:
      return {};
  }
}
