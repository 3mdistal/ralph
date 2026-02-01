import { appendFile, mkdir, open, readFile, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";

import { getRalphSessionDir, getRalphSessionNudgesPath } from "./paths";
import { redactSensitiveText } from "./redaction";

export interface PendingNudge {
  id: string;
  message: string;
  createdAt: number;
  failedAttempts: number;
}

export type NudgePreview = {
  len: number;
  preview: string;
};

export type NudgeDeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "failed"; error?: string }
  | { kind: "deferred"; reason: string };

export type NudgeQueueState = {
  pending: PendingNudge[];
  blocked?: PendingNudge;
};

type NudgeEvent =
  | {
      type: "nudge";
      id: string;
      ts: number;
      sessionId: string;
      message: string;
      taskRef?: string;
      taskPath?: string;
      repo?: string;
    }
  | {
      type: "delivery";
      id: string;
      ts: number;
      sessionId: string;
      success: boolean;
      error?: string;
    };

function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function truncate(value: string, max = 800): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

export function buildNudgePreview(message: string, maxPreview = 160): NudgePreview {
  const raw = String(message ?? "");
  const redacted = redactSensitiveText(raw).trim();
  const preview = redacted.length > maxPreview ? `${redacted.slice(0, maxPreview)}...` : redacted;
  return { len: raw.length, preview };
}

const DRAIN_LOCK_TTL_MS = 10 * 60_000;

async function acquireDrainLock(sessionId: string): Promise<(() => Promise<void>) | null> {
  const lockPath = join(getRalphSessionDir(sessionId), "nudges.drain.lock");
  await mkdir(dirname(lockPath), { recursive: true });

  const tryCreate = async (): Promise<(() => Promise<void>) | null> => {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ ts: Date.now(), pid: process.pid, sessionId }) + "\n",
          "utf8"
        );
      } finally {
        await handle.close();
      }

      return async () => {
        try {
          await rm(lockPath, { force: true });
        } catch {
          // ignore
        }
      };
    } catch (e: any) {
      if (e?.code !== "EEXIST") return null;
      return null;
    }
  };

  const created = await tryCreate();
  if (created) return created;

  // Best-effort stale lock cleanup.
  try {
    const st = await stat(lockPath);
    if (Date.now() - st.mtimeMs > DRAIN_LOCK_TTL_MS) {
      await rm(lockPath, { force: true });
      return await tryCreate();
    }
  } catch {
    // ignore
  }

  return null;
}

async function appendEvent(sessionId: string, event: NudgeEvent): Promise<void> {
  const nudgesPath = getRalphSessionNudgesPath(sessionId);
  await mkdir(dirname(nudgesPath), { recursive: true });
  await appendFile(nudgesPath, JSON.stringify(event) + "\n");
}

async function readEvents(sessionId: string): Promise<NudgeEvent[]> {
  const nudgesPath = getRalphSessionNudgesPath(sessionId);
  if (!existsSync(nudgesPath)) return [];

  const raw = await readFile(nudgesPath, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const out: NudgeEvent[] = [];
  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") continue;
    if (parsed.type !== "nudge" && parsed.type !== "delivery") continue;
    if (typeof parsed.id !== "string" || typeof parsed.ts !== "number" || typeof parsed.sessionId !== "string") continue;
    out.push(parsed as NudgeEvent);
  }

  return out;
}

function buildQueueState(events: NudgeEvent[], maxAttempts: number): NudgeQueueState {
  const order: string[] = [];
  const nudges = new Map<
    string,
    { message: string; createdAt: number; failedAttempts: number; delivered: boolean }
  >();

  for (const event of events) {
    if (event.type === "nudge") {
      if (!nudges.has(event.id)) {
        nudges.set(event.id, {
          message: event.message,
          createdAt: event.ts,
          failedAttempts: 0,
          delivered: false,
        });
        order.push(event.id);
      }
      continue;
    }

    const nudge = nudges.get(event.id);
    if (!nudge) continue;

    if (event.success) {
      nudge.delivered = true;
    } else {
      nudge.failedAttempts += 1;
    }
  }

  const pending: PendingNudge[] = [];
  for (const id of order) {
    const nudge = nudges.get(id);
    if (!nudge || nudge.delivered) continue;

    if (nudge.failedAttempts >= maxAttempts) {
      return {
        pending: [],
        blocked: {
          id,
          message: nudge.message,
          createdAt: nudge.createdAt,
          failedAttempts: nudge.failedAttempts,
        },
      };
    }

    pending.push({
      id,
      message: nudge.message,
      createdAt: nudge.createdAt,
      failedAttempts: nudge.failedAttempts,
    });
  }

  return { pending };
}

export async function queueNudge(
  sessionId: string,
  message: string,
  meta?: { taskRef?: string; taskPath?: string; repo?: string }
): Promise<string> {
  const id = randomUUID();
  await appendEvent(sessionId, {
    type: "nudge",
    id,
    ts: Date.now(),
    sessionId,
    message,
    taskRef: meta?.taskRef,
    taskPath: meta?.taskPath,
    repo: meta?.repo,
  });
  return id;
}

export async function recordDeliveryAttempt(
  sessionId: string,
  nudgeId: string,
  result: { success: boolean; error?: string }
): Promise<void> {
  await appendEvent(sessionId, {
    type: "delivery",
    id: nudgeId,
    ts: Date.now(),
    sessionId,
    success: result.success,
    error: result.error ? truncate(result.error) : undefined,
  });
}

export async function getPendingNudges(sessionId: string, maxAttempts = 3): Promise<PendingNudge[]> {
  const events = await readEvents(sessionId);
  const state = buildQueueState(events, maxAttempts);
  return state.pending;
}

export async function getNudgeQueueState(sessionId: string, maxAttempts = 3): Promise<NudgeQueueState> {
  const events = await readEvents(sessionId);
  return buildQueueState(events, maxAttempts);
}

export interface DrainResult {
  attempted: number;
  delivered: number;
  stoppedOnError: boolean;
  deferred: boolean;
  deferredReason?: string;
  deferredNudgeId?: string;
  blocked: boolean;
  blockedNudge?: PendingNudge;
}

export async function drainQueuedNudges(
  sessionId: string,
  deliver: (message: string) => Promise<NudgeDeliveryOutcome>,
  opts?: {
    maxAttempts?: number;
    onDetect?: (state: NudgeQueueState) => void;
    onAttempt?: (nudge: PendingNudge) => void;
    onOutcome?: (nudge: PendingNudge, outcome: NudgeDeliveryOutcome) => void;
  }
): Promise<DrainResult> {
  const release = await acquireDrainLock(sessionId);
  if (!release) {
    return {
      attempted: 0,
      delivered: 0,
      stoppedOnError: false,
      deferred: false,
      blocked: false,
    };
  }

  let attempted = 0;
  let delivered = 0;
  let stoppedOnError = false;
  let deferred = false;
  let deferredReason: string | undefined;
  let deferredNudgeId: string | undefined;
  let blocked = false;
  let blockedNudge: PendingNudge | undefined;

  try {
    const maxAttempts = opts?.maxAttempts ?? 3;
    const state = await getNudgeQueueState(sessionId, maxAttempts);
    opts?.onDetect?.(state);

    if (state.blocked) {
      blocked = true;
      blockedNudge = state.blocked;
      return {
        attempted,
        delivered,
        stoppedOnError,
        deferred,
        blocked,
        blockedNudge,
      };
    }

    for (const nudge of state.pending) {
      opts?.onAttempt?.(nudge);
      const outcome = await deliver(nudge.message);
      opts?.onOutcome?.(nudge, outcome);

      if (outcome.kind === "deferred") {
        deferred = true;
        deferredReason = outcome.reason;
        deferredNudgeId = nudge.id;
        break;
      }

      attempted += 1;
      if (outcome.kind === "failed") {
        await recordDeliveryAttempt(sessionId, nudge.id, { success: false, error: outcome.error });
        stoppedOnError = true;
        break;
      }

      await recordDeliveryAttempt(sessionId, nudge.id, { success: true });
      delivered += 1;
    }
  } finally {
    await release();
  }

  return {
    attempted,
    delivered,
    stoppedOnError,
    deferred,
    deferredReason,
    deferredNudgeId,
    blocked,
    blockedNudge,
  };
}
