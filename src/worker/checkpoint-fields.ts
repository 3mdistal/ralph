import { isRalphCheckpoint, type RalphCheckpoint } from "../dashboard/events";
import type { CheckpointState } from "../checkpoints/core";

export const CHECKPOINT_SEQ_FIELD = "checkpoint-seq";
export const PAUSE_REQUESTED_FIELD = "pause-requested";
export const PAUSED_AT_CHECKPOINT_FIELD = "paused-at-checkpoint";

export function parseCheckpointSeq(value?: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function parsePauseRequested(value?: string): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function parseCheckpointValue(value?: string): RalphCheckpoint | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isRalphCheckpoint(trimmed) ? (trimmed as RalphCheckpoint) : null;
}

export function buildCheckpointPatch(state: CheckpointState): Record<string, string> {
  return {
    checkpoint: state.lastCheckpoint ?? "",
    [CHECKPOINT_SEQ_FIELD]: String(state.checkpointSeq),
    [PAUSE_REQUESTED_FIELD]: state.pauseRequested ? "true" : "false",
    [PAUSED_AT_CHECKPOINT_FIELD]: state.pausedAtCheckpoint ?? "",
  };
}
