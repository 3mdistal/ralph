import { existsSync } from "fs";
import { open, stat } from "fs/promises";

import { getSessionEventsPath } from "./paths";

export type ActivityLabel =
  | "planning"
  | "searching"
  | "reading"
  | "editing"
  | "testing"
  | "git"
  | "github"
  | "docs"
  | "waiting"
  | "unknown";

export const ACTIVITY_WINDOW_MS = 60_000;
export const ACTIVITY_IDLE_MS = 10_000;
export const ACTIVITY_EMIT_INTERVAL_MS = 15_000;

const ACTIVITY_PRECEDENCE: ActivityLabel[] = [
  "testing",
  "github",
  "git",
  "editing",
  "reading",
  "searching",
  "planning",
  "docs",
  "waiting",
  "unknown",
];

const TEST_RE = /\b(pytest|go test|npm test|bun test|cargo test)\b/i;
const GITHUB_RE = /\bgh\b/i;
const GIT_RE = /\bgit\b/i;
const READ_RE = /\b(read|cat|sed -n|less)\b/i;
const EDIT_RE = /\b(edit|write|apply patch|sed -i)\b/i;
const SEARCH_RE = /\b(rg|ripgrep|grep|glob|find)\b/i;
const DOCS_RE = /(\/docs\/|\bREADME\b)/i;

const TOOL_NAME_MAP: Array<{ match: RegExp; label: ActivityLabel }> = [
  { match: /\b(read)\b/i, label: "reading" },
  { match: /\b(edit|write)\b/i, label: "editing" },
  { match: /\b(grep|glob|search)\b/i, label: "searching" },
  { match: /\b(task|question)\b/i, label: "planning" },
];

export type ActivitySnapshot = {
  activity: ActivityLabel;
  lastSignalTs?: number;
};

function toActivityLabel(label: string): ActivityLabel | null {
  if (
    label === "planning" ||
    label === "searching" ||
    label === "reading" ||
    label === "editing" ||
    label === "testing" ||
    label === "git" ||
    label === "github" ||
    label === "docs" ||
    label === "waiting" ||
    label === "unknown"
  ) {
    return label;
  }
  return null;
}

async function readTailText(filePath: string, maxBytes = 128 * 1024): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const statInfo = await handle.stat();
    const size = Number(statInfo.size);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

function scoreFromText(text: string): ActivityLabel | null {
  if (!text) return null;

  if (TEST_RE.test(text)) return "testing";
  if (GITHUB_RE.test(text)) return "github";
  if (GIT_RE.test(text)) return "git";
  if (EDIT_RE.test(text)) return "editing";
  if (READ_RE.test(text)) return "reading";
  if (SEARCH_RE.test(text)) return "searching";
  if (DOCS_RE.test(text)) return "docs";
  return null;
}

function parseArgsPreview(argsPreview: string | undefined): string | null {
  if (!argsPreview) return null;
  const trimmed = argsPreview.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const command = (parsed as any).command;
        if (typeof command === "string") return command;
        const input = (parsed as any).input;
        if (typeof input === "string") return input;
      }
    } catch {
      // fall through
    }
  }

  return trimmed;
}

function addScore(scores: Map<ActivityLabel, number>, label: ActivityLabel, weight = 1): void {
  scores.set(label, (scores.get(label) ?? 0) + weight);
}

function pickBestLabel(scores: Map<ActivityLabel, number>): ActivityLabel {
  if (scores.size === 0) return "unknown";

  let best: ActivityLabel = "unknown";
  let bestScore = -1;

  for (const label of ACTIVITY_PRECEDENCE) {
    const score = scores.get(label) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = label;
    }
  }

  return best;
}

function scoreFromTool(toolName: string, argsPreview?: string): ActivityLabel | null {
  const normalized = toolName.trim().toLowerCase();
  for (const entry of TOOL_NAME_MAP) {
    if (entry.match.test(normalized)) return entry.label;
  }

  if (normalized === "bash" || normalized === "shell") {
    const command = parseArgsPreview(argsPreview) ?? "";
    return scoreFromText(command);
  }

  return null;
}

function scoreFromStepTitle(title: string | undefined): ActivityLabel | null {
  if (!title) return null;
  const normalized = title.toLowerCase();
  if (normalized.includes("next-task") || normalized.includes("plan")) return "planning";
  if (normalized.includes("docs") || normalized.includes("document") || normalized.includes("consult")) return "docs";
  return null;
}

async function readSessionSignals(params: {
  sessionId: string;
  now: number;
  windowMs: number;
}): Promise<{ scores: Map<ActivityLabel, number>; lastSignalTs?: number }> {
  const { sessionId, now, windowMs } = params;
  const scores = new Map<ActivityLabel, number>();
  const eventsPath = getSessionEventsPath(sessionId);
  if (!existsSync(eventsPath)) return { scores };

  let text: string;
  try {
    text = await readTailText(eventsPath);
  } catch {
    return { scores };
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let lastSignalTs: number | undefined;

  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = typeof event?.ts === "number" ? event.ts : undefined;
    if (typeof ts === "number") {
      if (ts > (lastSignalTs ?? 0)) lastSignalTs = ts;
      if (ts < now - windowMs) continue;
    }

    const type = String(event?.type ?? "");
    if (type === "tool-start") {
      const label = scoreFromTool(String(event?.toolName ?? ""), event?.argsPreview);
      if (label) addScore(scores, label);
      continue;
    }

    if (type === "step-start" || type === "run-start") {
      const label = scoreFromStepTitle(event?.title ?? event?.stepTitle ?? event?.step_title);
      if (label) addScore(scores, label);
    }

    if (type === "log.opencode.text") {
      const label = scoreFromText(String(event?.text ?? ""));
      if (label) addScore(scores, label);
    }

    const textFields = [event?.text, event?.message, event?.output].filter((value) => typeof value === "string");
    if (textFields.length > 0) {
      const label = scoreFromText(textFields.join("\n"));
      if (label) addScore(scores, label);
    }
  }

  return { scores, lastSignalTs };
}

async function readRunLogSignal(params: {
  runLogPath?: string;
}): Promise<{ label?: ActivityLabel; lastSignalTs?: number }> {
  const runLogPath = params.runLogPath?.trim();
  if (!runLogPath) return {};
  if (!existsSync(runLogPath)) return {};

  try {
    const statInfo = await stat(runLogPath);
    const text = await readTailText(runLogPath);
    const label = scoreFromText(text);
    return { label: label ?? undefined, lastSignalTs: statInfo.mtimeMs };
  } catch {
    return {};
  }
}

export async function classifyActivity(params: {
  sessionId?: string;
  runLogPath?: string;
  now?: number;
  windowMs?: number;
  idleMs?: number;
}): Promise<ActivitySnapshot> {
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? ACTIVITY_WINDOW_MS;
  const idleMs = params.idleMs ?? ACTIVITY_IDLE_MS;

  let scores = new Map<ActivityLabel, number>();
  let lastSignalTs: number | undefined;

  if (params.sessionId) {
    const sessionSignals = await readSessionSignals({ sessionId: params.sessionId, now, windowMs });
    scores = sessionSignals.scores;
    lastSignalTs = sessionSignals.lastSignalTs;
  }

  if (scores.size === 0) {
    const runLog = await readRunLogSignal({ runLogPath: params.runLogPath });
    if (runLog.label) addScore(scores, runLog.label);
    if (runLog.lastSignalTs && (lastSignalTs ?? 0) < runLog.lastSignalTs) {
      lastSignalTs = runLog.lastSignalTs;
    }
  }

  let activity = pickBestLabel(scores);

  if (lastSignalTs && now - lastSignalTs >= idleMs) {
    activity = "waiting";
  }

  if (!lastSignalTs && activity === "unknown") {
    return { activity: "waiting" };
  }

  if (!lastSignalTs && activity !== "unknown") {
    return { activity };
  }

  return { activity, lastSignalTs };
}

export function parseActivityLabel(value: string): ActivityLabel {
  return toActivityLabel(value) ?? "unknown";
}
