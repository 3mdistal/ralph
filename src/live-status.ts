import { existsSync } from "fs";
import { open } from "fs/promises";

import { getSessionEventsPath } from "./paths";
import { formatDuration } from "./logging";

export interface SessionNowDoing {
  sessionId: string;
  step?: number;
  stepTitle?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgsPreview?: string;
  toolElapsedMs?: number;
  taskName?: string;
  issue?: string;
  repo?: string;
  updatedAtTs?: number;
}

async function readTailText(filePath: string, maxBytes = 64 * 1024): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    const size = Number(stat.size);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

function tailLines(text: string, maxLines: number): string[] {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxLines) return lines;
  return lines.slice(lines.length - maxLines);
}

function safeJson(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function getSessionNowDoing(sessionId: string): Promise<SessionNowDoing | null> {
  const path = getSessionEventsPath(sessionId);
  if (!existsSync(path)) return null;

  let text: string;
  try {
    text = await readTailText(path);
  } catch {
    return null;
  }

  const lines = tailLines(text, 250);
  const now = Date.now();

  let step: number | undefined;
  let stepTitle: string | undefined;
  let taskName: string | undefined;
  let issue: string | undefined;
  let repo: string | undefined;

  let inFlight: { toolName: string; callId: string; ts: number; argsPreview?: string } | null = null;
  let updatedAtTs: number | undefined;

  for (const line of lines) {
    const event = safeJson(line);
    if (!event) continue;

    const type = String(event.type ?? "");
    const ts = typeof event.ts === "number" ? event.ts : undefined;
    if (ts) updatedAtTs = ts;

    if (type === "step-start") {
      if (typeof event.step === "number") step = event.step;
      if (typeof event.title === "string") stepTitle = event.title;
      if (typeof event.taskName === "string") taskName = event.taskName;
      if (typeof event.issue === "string") issue = event.issue;
      if (typeof event.repo === "string") repo = event.repo;
      continue;
    }

    if (type === "tool-start") {
      const toolName = String(event.toolName ?? "unknown");
      const callId = String(event.callId ?? "unknown");
      const tts = typeof event.ts === "number" ? event.ts : now;
      inFlight = {
        toolName,
        callId,
        ts: tts,
        argsPreview: typeof event.argsPreview === "string" ? event.argsPreview : undefined,
      };
      continue;
    }

    if (type === "tool-end") {
      const callId = String(event.callId ?? "unknown");
      if (inFlight && (inFlight.callId === callId || inFlight.callId === "unknown" || callId === "unknown")) {
        inFlight = null;
      }
      continue;
    }
  }

  const out: SessionNowDoing = {
    sessionId,
    step,
    stepTitle,
    toolName: inFlight?.toolName,
    toolCallId: inFlight?.callId,
    toolArgsPreview: inFlight?.argsPreview,
    toolElapsedMs: inFlight ? now - inFlight.ts : undefined,
    taskName,
    issue,
    repo,
    updatedAtTs,
  };

  return out;
}

export function formatNowDoingLine(nowDoing: SessionNowDoing, fallbackTitle?: string): string {
  const title = fallbackTitle ?? nowDoing.taskName ?? "(unknown task)";
  const step = nowDoing.step != null ? `Step ${nowDoing.step}` : "Step ?";
  const stepTitle = nowDoing.stepTitle ? `: ${nowDoing.stepTitle}` : "";

  if (nowDoing.toolName && typeof nowDoing.toolElapsedMs === "number") {
    const tool = `running ${nowDoing.toolName}`;
    const elapsed = `[${formatDuration(nowDoing.toolElapsedMs)}]`;
    return `${title} — ${step}${stepTitle}: ${tool} ${elapsed}`;
  }

  if (nowDoing.updatedAtTs) {
    const idleFor = `[idle ${formatDuration(Date.now() - nowDoing.updatedAtTs)}]`;
    return `${title} — ${step}${stepTitle}: waiting ${idleFor}`;
  }

  return `${title} — ${step}${stepTitle}: waiting`;
}
