import type { RalphCheckpoint } from "../dashboard/events";

export type CheckpointState = {
  lastCheckpoint: RalphCheckpoint | null;
  checkpointSeq: number;
  pausedAtCheckpoint: RalphCheckpoint | null;
  pauseRequested: boolean;
};

export type CheckpointEmitEventType =
  | "worker.checkpoint.reached"
  | "worker.pause.requested"
  | "worker.pause.reached"
  | "worker.pause.cleared";

export type CheckpointEffect =
  | {
      kind: "persist";
      state: CheckpointState;
    }
  | {
      kind: "emit";
      eventType: CheckpointEmitEventType;
      checkpoint?: RalphCheckpoint;
      idempotencyKey: string;
    }
  | {
      kind: "wait";
      reason: "pause";
    };

export function buildCheckpointState(input?: Partial<CheckpointState>): CheckpointState {
  return {
    lastCheckpoint: input?.lastCheckpoint ?? null,
    checkpointSeq: input?.checkpointSeq ?? 0,
    pausedAtCheckpoint: input?.pausedAtCheckpoint ?? null,
    pauseRequested: input?.pauseRequested ?? false,
  };
}

function buildCheckpointIdempotencyKey(params: {
  workerId: string;
  eventType: CheckpointEmitEventType;
  checkpointSeq: number;
  checkpoint?: RalphCheckpoint;
}): string {
  const checkpoint = params.checkpoint ?? "";
  return `${params.eventType}:${params.workerId}:${checkpoint}:${params.checkpointSeq}`;
}

export function onCheckpointReached(params: {
  checkpoint: RalphCheckpoint;
  state: CheckpointState;
  pauseRequested: boolean;
  workerId: string;
}): { state: CheckpointState; effects: CheckpointEffect[] } {
  if (params.pauseRequested && params.state.pausedAtCheckpoint === params.checkpoint) {
    return {
      state: {
        ...params.state,
        pauseRequested: true,
      },
      effects: [{ kind: "wait", reason: "pause" }],
    };
  }

  const nextSeq = params.state.checkpointSeq + 1;
  const nextState: CheckpointState = {
    lastCheckpoint: params.checkpoint,
    checkpointSeq: nextSeq,
    pausedAtCheckpoint: params.pauseRequested ? params.checkpoint : null,
    pauseRequested: params.pauseRequested,
  };

  const effects: CheckpointEffect[] = [];

  effects.push({ kind: "persist", state: nextState });

  effects.push({
    kind: "emit",
    eventType: "worker.checkpoint.reached",
    checkpoint: params.checkpoint,
    idempotencyKey: buildCheckpointIdempotencyKey({
      workerId: params.workerId,
      eventType: "worker.checkpoint.reached",
      checkpointSeq: nextSeq,
      checkpoint: params.checkpoint,
    }),
  });

  if (params.pauseRequested && !params.state.pauseRequested) {
    effects.push({
      kind: "emit",
      eventType: "worker.pause.requested",
      idempotencyKey: buildCheckpointIdempotencyKey({
        workerId: params.workerId,
        eventType: "worker.pause.requested",
        checkpointSeq: nextSeq,
      }),
    });
  }

  if (params.pauseRequested) {
    effects.push({
      kind: "emit",
      eventType: "worker.pause.reached",
      checkpoint: params.checkpoint,
      idempotencyKey: buildCheckpointIdempotencyKey({
        workerId: params.workerId,
        eventType: "worker.pause.reached",
        checkpointSeq: nextSeq,
        checkpoint: params.checkpoint,
      }),
    });
    effects.push({ kind: "wait", reason: "pause" });
  }

  return { state: nextState, effects };
}

export function onPauseCleared(params: {
  state: CheckpointState;
  pauseRequested: boolean;
  workerId: string;
}): { state: CheckpointState; effects: CheckpointEffect[] } {
  const effects: CheckpointEffect[] = [];

  const nextState: CheckpointState = {
    ...params.state,
    pauseRequested: params.pauseRequested,
    pausedAtCheckpoint: null,
  };

  if (params.state.pausedAtCheckpoint) {
    effects.push({ kind: "persist", state: nextState });
    effects.push({
      kind: "emit",
      eventType: "worker.pause.cleared",
      idempotencyKey: buildCheckpointIdempotencyKey({
        workerId: params.workerId,
        eventType: "worker.pause.cleared",
        checkpointSeq: params.state.checkpointSeq,
        checkpoint: params.state.pausedAtCheckpoint,
      }),
    });
  }

  return { state: nextState, effects };
}
