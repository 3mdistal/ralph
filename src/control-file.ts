import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { resolveControlFilePath, type DaemonMode } from "./drain";

type ControlFileShape = Record<string, unknown>;

export type ControlFilePatch = {
  mode?: DaemonMode;
  pauseRequested?: boolean | null;
  pauseAtCheckpoint?: string | null;
  drainTimeoutMs?: number | null;
  opencodeProfile?: string | null;
};

function readControlFileJson(path: string): ControlFileShape {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ControlFileShape;
  } catch {
    return {};
  }
}

function writeControlFileJson(path: string, payload: ControlFileShape): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function applyPatch(current: ControlFileShape, patch: ControlFilePatch): ControlFileShape {
  const next: ControlFileShape = { ...current, version: 1 };

  if (patch.mode) next.mode = patch.mode;

  if (patch.pauseRequested === null) delete next.pause_requested;
  else if (typeof patch.pauseRequested === "boolean") next.pause_requested = patch.pauseRequested;

  if (patch.pauseAtCheckpoint === null) delete next.pause_at_checkpoint;
  else if (typeof patch.pauseAtCheckpoint === "string" && patch.pauseAtCheckpoint.trim()) {
    next.pause_at_checkpoint = patch.pauseAtCheckpoint.trim();
  }

  if (patch.drainTimeoutMs === null) delete next.drain_timeout_ms;
  else if (typeof patch.drainTimeoutMs === "number" && Number.isFinite(patch.drainTimeoutMs)) {
    next.drain_timeout_ms = Math.max(0, Math.floor(patch.drainTimeoutMs));
  }

  if (patch.opencodeProfile === null) delete next.opencode_profile;
  else if (typeof patch.opencodeProfile === "string" && patch.opencodeProfile.trim()) {
    next.opencode_profile = patch.opencodeProfile.trim();
  }

  return next;
}

export function updateControlFile(opts: { patch: ControlFilePatch; path?: string }): { path: string; state: ControlFileShape } {
  const path = opts.path ?? resolveControlFilePath();
  const current = readControlFileJson(path);
  const next = applyPatch(current, opts.patch);
  writeControlFileJson(path, next);
  return { path, state: next };
}
