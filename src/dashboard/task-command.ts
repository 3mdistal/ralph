import {
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_CMD_SATISFY,
  RALPH_LABEL_CMD_STOP,
} from "../github-labels";
import { parseIssueRef } from "../github/issue-ref";

const MAX_COMMENT_LENGTH = 2_000;

export type TaskCommand = "queue" | "pause" | "stop" | "satisfy";

export type ParsedTaskCommandRequest = {
  taskId: string;
  command: TaskCommand;
  comment: string | null;
};

export type GitHubTaskCommandPlan = {
  taskId: string;
  repo: string;
  issueNumber: number;
  command: TaskCommand;
  cmdLabel: string;
  comment: string | null;
};

export class ControlPlaneRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ControlPlaneRequestError";
    this.status = status;
    this.code = code;
  }
}

function toCommandLabel(command: TaskCommand): string {
  switch (command) {
    case "queue":
      return RALPH_LABEL_CMD_QUEUE;
    case "pause":
      return RALPH_LABEL_CMD_PAUSE;
    case "stop":
      return RALPH_LABEL_CMD_STOP;
    case "satisfy":
      return RALPH_LABEL_CMD_SATISFY;
  }
}

function normalizeComment(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ControlPlaneRequestError(400, "bad_request", "comment must be a string when provided");
  }

  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new ControlPlaneRequestError(400, "bad_request", `comment exceeds max length (${MAX_COMMENT_LENGTH})`);
  }
  return trimmed;
}

export function parseTaskCommandRequest(body: unknown): ParsedTaskCommandRequest {
  const taskId = typeof (body as any)?.taskId === "string" ? (body as any).taskId.trim() : "";
  if (!taskId) {
    throw new ControlPlaneRequestError(400, "bad_request", "Missing taskId");
  }

  const commandRaw = typeof (body as any)?.command === "string" ? (body as any).command.trim().toLowerCase() : "";
  if (!commandRaw) {
    throw new ControlPlaneRequestError(400, "bad_request", "Missing command");
  }
  if (commandRaw !== "queue" && commandRaw !== "pause" && commandRaw !== "stop" && commandRaw !== "satisfy") {
    throw new ControlPlaneRequestError(400, "bad_request", "Invalid command");
  }

  return {
    taskId,
    command: commandRaw,
    comment: normalizeComment((body as any)?.comment),
  };
}

export function buildGitHubTaskCommandPlan(params: {
  taskId: string;
  command: TaskCommand;
  comment?: string | null;
  allowedRepos: ReadonlySet<string>;
}): GitHubTaskCommandPlan {
  if (!params.taskId.startsWith("github:")) {
    throw new ControlPlaneRequestError(400, "bad_request", "taskId must use github:OWNER/REPO#NUMBER format");
  }

  const issueRef = parseIssueRef(params.taskId.slice("github:".length), "");
  if (!issueRef) {
    throw new ControlPlaneRequestError(400, "bad_request", "taskId must use github:OWNER/REPO#NUMBER format");
  }

  if (!params.allowedRepos.has(issueRef.repo)) {
    throw new ControlPlaneRequestError(403, "forbidden", `repo is not configured for this daemon: ${issueRef.repo}`);
  }

  const comment = normalizeComment(params.comment);
  return {
    taskId: params.taskId,
    repo: issueRef.repo,
    issueNumber: issueRef.number,
    command: params.command,
    cmdLabel: toCommandLabel(params.command),
    comment,
  };
}
