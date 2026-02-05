import type { AgentTask } from "../queue-backend";
import type { ControlDefaults, ControlState } from "../drain";
import type { RalphCheckpoint, RalphEvent } from "../dashboard/events";
import { buildCheckpointState, type CheckpointState } from "../checkpoints/core";
import { applyCheckpointReached } from "../checkpoints/runtime";
import {
  buildCheckpointPatch,
  CHECKPOINT_SEQ_FIELD,
  PAUSED_AT_CHECKPOINT_FIELD,
  PAUSE_REQUESTED_FIELD,
  parseCheckpointSeq,
  parseCheckpointValue,
  parsePauseRequested,
} from "./checkpoint-fields";

export type PauseControlSnapshot = {
  pauseRequested: boolean;
  pauseAtCheckpoint: RalphCheckpoint | null;
};

export type PauseControl = {
  readPauseControl: () => PauseControlSnapshot;
  readPauseRequested: () => boolean;
  waitForPauseCleared: (opts?: { signal?: AbortSignal }) => Promise<void>;
};

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;
type JitterFn = () => number;

type PauseControlDeps = {
  readControlStateSnapshot: (opts: { log?: (message: string) => void; defaults?: Partial<ControlDefaults> }) => ControlState;
  defaults?: Partial<ControlDefaults>;
  isRalphCheckpoint: (value: string) => boolean;
  log?: (message: string) => void;
  sleep?: SleepFn;
  jitter?: JitterFn;
};

export function createPauseControl(deps: PauseControlDeps): PauseControl {
  const readPauseControl = (): PauseControlSnapshot => {
    const control = deps.readControlStateSnapshot({ log: deps.log, defaults: deps.defaults });
    const pauseRequested = control.pauseRequested === true;
    const pauseAtCheckpoint =
      typeof control.pauseAtCheckpoint === "string" && deps.isRalphCheckpoint(control.pauseAtCheckpoint)
        ? (control.pauseAtCheckpoint as RalphCheckpoint)
        : null;

    return { pauseRequested, pauseAtCheckpoint };
  };

  const readPauseRequested = (): boolean => readPauseControl().pauseRequested;

  const waitForPauseCleared = async (opts?: { signal?: AbortSignal }): Promise<void> => {
    const minMs = 250;
    const maxMs = 2000;
    let delayMs = minMs;

    while (readPauseRequested()) {
      if (opts?.signal?.aborted) return;
      await (deps.sleep ?? sleepWithAbort)(delayMs, opts?.signal);
      const jitter = (deps.jitter ?? defaultJitter)();
      delayMs = Math.min(maxMs, Math.floor(delayMs * 1.6) + jitter);
    }
  };

  return { readPauseControl, readPauseRequested, waitForPauseCleared };
}

export type RecordCheckpointParams = {
  task: AgentTask;
  checkpoint: RalphCheckpoint;
  workerId: string;
  repo: string;
  sessionId?: string;
  pauseControl: PauseControl;
  updateTaskStatus: (
    task: AgentTask,
    status: AgentTask["status"],
    extraFields: Record<string, string>
  ) => Promise<boolean>;
  applyTaskPatch: (task: AgentTask, status: AgentTask["status"], extraFields: Record<string, string>) => void;
  emitter: {
    emit: (event: RalphEvent, idempotencyKey: string) => void;
    hasEmitted?: (idempotencyKey: string) => boolean;
  };
  log?: (message: string) => void;
};

export async function recordCheckpoint(params: RecordCheckpointParams): Promise<void> {
  const state = getCheckpointState(params.task);
  const warn = params.log ?? ((message: string) => console.warn(message));

  const store = {
    persist: async (nextState: CheckpointState) => {
      const patch = buildCheckpointPatch(nextState);
      try {
        const updated = await params.updateTaskStatus(params.task, params.task.status, patch);
        if (!updated) {
          warn(
            `[ralph:worker:${params.repo}] Failed to persist checkpoint state (checkpoint=${params.checkpoint}, task=${params.task.issue})`
          );
          return;
        }
        params.applyTaskPatch(params.task, params.task.status, patch);
      } catch (error: any) {
        warn(
          `[ralph:worker:${params.repo}] Failed to persist checkpoint state (checkpoint=${params.checkpoint}, task=${params.task.issue}): ${
            error?.message ?? String(error)
          }`
        );
      }
    },
  };

  const pauseSource = {
    isPauseRequested: () => params.pauseControl.readPauseRequested(),
    waitUntilCleared: (opts?: { signal?: AbortSignal }) => params.pauseControl.waitForPauseCleared(opts),
  };

  const pauseAtCheckpoint = params.pauseControl.readPauseControl().pauseAtCheckpoint;

  await applyCheckpointReached({
    checkpoint: params.checkpoint,
    pauseAtCheckpoint,
    state,
    context: {
      workerId: params.workerId,
      repo: params.repo,
      taskId: params.task._path,
      sessionId: params.sessionId ?? (params.task["session-id"]?.trim() || undefined),
    },
    store,
    pauseSource,
    emitter: params.emitter,
  });
}

function getCheckpointState(task: AgentTask): CheckpointState {
  return buildCheckpointState({
    lastCheckpoint: parseCheckpointValue(task.checkpoint),
    checkpointSeq: parseCheckpointSeq(task[CHECKPOINT_SEQ_FIELD]),
    pausedAtCheckpoint: parseCheckpointValue(task[PAUSED_AT_CHECKPOINT_FIELD]),
    pauseRequested: parsePauseRequested(task[PAUSE_REQUESTED_FIELD]),
  });
}

function defaultJitter(): number {
  return Math.floor(Math.random() * 125);
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      finish();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
      finish();
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
