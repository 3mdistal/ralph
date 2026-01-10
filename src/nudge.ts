import { appendFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { dirname } from "path";

import { getRalphSessionNudgesPath } from "./paths";

export interface PendingNudge {
  id: string;
  message: string;
  createdAt: number;
  failedAttempts: number;
}

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

  const nudges = new Map<string, { message: string; createdAt: number; failedAttempts: number; delivered: boolean }>();

  for (const event of events) {
    if (event.type === "nudge") {
      if (!nudges.has(event.id)) {
        nudges.set(event.id, {
          message: event.message,
          createdAt: event.ts,
          failedAttempts: 0,
          delivered: false,
        });
      }
      continue;
    }

    const nudge = nudges.get(event.id);
    if (!nudge) continue;

    if (event.success) {
      nudge.delivered = true;
    } else {
      nudge.failedAttempts++;
    }
  }

  const pending: PendingNudge[] = [];
  for (const [id, nudge] of nudges) {
    if (nudge.delivered) continue;
    if (nudge.failedAttempts >= maxAttempts) continue;
    pending.push({ id, message: nudge.message, createdAt: nudge.createdAt, failedAttempts: nudge.failedAttempts });
  }

  pending.sort((a, b) => a.createdAt - b.createdAt);
  return pending;
}

export interface DrainResult {
  attempted: number;
  delivered: number;
  stoppedOnError: boolean;
}

export async function drainQueuedNudges(
  sessionId: string,
  deliver: (message: string) => Promise<{ success: boolean; error?: string }>,
  opts?: { maxAttempts?: number }
): Promise<DrainResult> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const pending = await getPendingNudges(sessionId, maxAttempts);

  let attempted = 0;
  let delivered = 0;

  for (const nudge of pending) {
    attempted++;
    const result = await deliver(nudge.message);
    await recordDeliveryAttempt(sessionId, nudge.id, result);

    if (!result.success) {
      return { attempted, delivered, stoppedOnError: true };
    }

    delivered++;
  }

  return { attempted, delivered, stoppedOnError: false };
}
