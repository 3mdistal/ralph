import type { WatchdogTimeoutInfo } from "./session";

const SIGNATURE_VERSION = "v2";
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const MAX_ARGS_PREVIEW = 200;
const REPEAT_THRESHOLD = 3;

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildWatchdogSignature(params: {
  stage: string;
  timeout?: WatchdogTimeoutInfo;
}): string {
  if (!params.timeout) return "";
  const source = params.timeout.source ?? "tool-watchdog";
  const argsPreview = normalizeArgsPreview(params.timeout.argsPreview);
  const parts = [
    SIGNATURE_VERSION,
    params.stage,
    source,
    params.timeout.toolName,
    argsPreview,
  ];
  return `${SIGNATURE_VERSION}:${hashFNV1a(parts.join("|"))}`;
}

export function shouldEarlyTerminateWatchdog(params: {
  retryCount: number;
  currentSignature: string;
  priorSignature?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  timeout?: WatchdogTimeoutInfo;
}): boolean {
  if (params.retryCount !== 0) return false;
  if (hasRepeatPattern(params.timeout)) return true;
  const prior = params.priorSignature?.trim() ?? "";
  if (!prior || !params.currentSignature) return false;
  if (!params.sessionId || !params.priorSessionId) return false;
  if (params.sessionId !== params.priorSessionId) return false;
  return prior === params.currentSignature;
}

function normalizeArgsPreview(input?: string): string {
  if (!input) return "";
  return input.trim().slice(0, MAX_ARGS_PREVIEW);
}

function parseEvent(line: string): any | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractToolEvent(event: any): { toolName: string; argsPreview?: string } | null {
  if (!event) return null;
  const toolName =
    event?.tool?.name ??
    event?.toolName ??
    event?.name ??
    event?.part?.tool?.name ??
    event?.part?.toolCall?.name ??
    event?.part?.tool_call?.name;
  if (!toolName) return null;
  const argsPreview =
    event?.tool?.input ??
    event?.tool?.args ??
    event?.tool?.arguments ??
    event?.part?.tool?.input ??
    event?.part?.tool?.args ??
    event?.part?.toolCall?.input ??
    event?.part?.toolCall?.args ??
    event?.part?.tool_call?.input ??
    event?.part?.tool_call?.args;
  return { toolName: String(toolName), argsPreview: argsPreview ? String(argsPreview) : undefined };
}

function hasRepeatPattern(timeout?: WatchdogTimeoutInfo): boolean {
  if (!timeout?.recentEvents?.length) return false;
  const targetTool = timeout.toolName;
  const targetArgs = normalizeArgsPreview(timeout.argsPreview);
  const counts = new Map<string, number>();

  for (const line of timeout.recentEvents) {
    const event = parseEvent(line);
    if (!event) continue;
    const tool = extractToolEvent(event);
    if (!tool) continue;
    if (tool.toolName !== targetTool) continue;
    const argsPreview = normalizeArgsPreview(tool.argsPreview);
    if (targetArgs && argsPreview !== targetArgs) continue;
    const key = `${tool.toolName}|${argsPreview}`;
    const next = (counts.get(key) ?? 0) + 1;
    if (next >= REPEAT_THRESHOLD) return true;
    counts.set(key, next);
  }

  return false;
}
