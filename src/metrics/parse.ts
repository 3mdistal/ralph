import type { NormalizedEvent } from "./types";

const SUPPORTED_TYPES = new Set(["run-start", "run-end", "step-start", "tool-start", "tool-end", "anomaly"]);

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function normalizeStepTitle(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeCallId(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeToolName(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function parseStepTitle(event: any): string | null {
  return normalizeStepTitle(event?.title ?? event?.stepTitle ?? event?.step_title);
}

export type ParsedEventsResult = {
  events: NormalizedEvent[];
  eventCount: number;
  parseErrorCount: number;
};

export function parseEventsFromLines(lines: Iterable<string>): ParsedEventsResult {
  const events: NormalizedEvent[] = [];
  let eventCount = 0;
  let parseErrorCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseErrorCount += 1;
      continue;
    }

    const type = typeof parsed?.type === "string" ? parsed.type : null;
    if (!type || !SUPPORTED_TYPES.has(type)) continue;

    const ts = toFiniteNumber(parsed?.ts);
    const stepTitle = type === "step-start" || type === "run-start" ? parseStepTitle(parsed) : null;
    const step = type === "step-start" || type === "run-start" ? toFiniteNumber(parsed?.step) : null;
    const toolName = type.startsWith("tool-") ? normalizeToolName(parsed?.toolName ?? parsed?.tool?.name) : null;
    const callId = type.startsWith("tool-") ? normalizeCallId(parsed?.callId ?? parsed?.tool?.callId) : null;

    events.push({
      type,
      ts,
      stepTitle,
      step,
      toolName,
      callId,
    });
    eventCount += 1;
  }

  return { events, eventCount, parseErrorCount };
}
