import { createHash } from "crypto";

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildStageSendMessageId(params: {
  sessionId: string;
  stage: string;
  content: string;
}): string {
  const sessionId = compact(params.sessionId);
  const stage = compact(params.stage);
  const content = compact(params.content);
  return `stg_${hashHex(`${sessionId}|${stage}|${content}`).slice(0, 24)}`;
}

export function buildStageSendLedgerKey(params: {
  repo: string;
  taskPath: string;
  stage: string;
}): string {
  const repo = compact(params.repo);
  const taskPath = compact(params.taskPath);
  const stage = compact(params.stage);
  return `ralph:stage-send:v1:${repo}:${taskPath}:${stage}`;
}

export function buildStageSendPayload(params: {
  repo: string;
  taskPath: string;
  stage: string;
  sessionId: string;
  messageId: string;
  mode: "message" | "command";
  command?: string;
  args?: string[];
  at: string;
}): string {
  return JSON.stringify({
    version: 1,
    repo: compact(params.repo),
    taskPath: compact(params.taskPath),
    stage: compact(params.stage),
    sessionId: compact(params.sessionId),
    messageId: compact(params.messageId),
    mode: params.mode,
    command: params.command ? compact(params.command) : undefined,
    args: params.args?.map((arg) => compact(arg)).filter(Boolean),
    at: params.at,
  });
}
