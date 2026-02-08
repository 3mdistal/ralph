import {
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_CMD_SATISFY,
  RALPH_LABEL_CMD_STOP,
} from "../github-labels";
import { parseIssueRef } from "../github/issue-ref";

export type TaskCommandLabel =
  | typeof RALPH_LABEL_CMD_QUEUE
  | typeof RALPH_LABEL_CMD_PAUSE
  | typeof RALPH_LABEL_CMD_STOP
  | typeof RALPH_LABEL_CMD_SATISFY;

export type TaskCommandValidationError = {
  code: string;
  message: string;
};

export const TASK_COMMAND_LABELS: readonly TaskCommandLabel[] = [
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_STOP,
  RALPH_LABEL_CMD_SATISFY,
];

export function mapTaskStatusInputToCmdLabel(rawStatus: string):
  | { ok: true; cmdLabel: TaskCommandLabel; normalizedStatus: string }
  | { ok: false; error: TaskCommandValidationError } {
  const normalizedStatus = rawStatus.trim().toLowerCase();
  if (!normalizedStatus) {
    return { ok: false, error: { code: "bad_request", message: "Missing status" } };
  }

  if (normalizedStatus === "queue" || normalizedStatus === "queued") {
    return { ok: true, cmdLabel: RALPH_LABEL_CMD_QUEUE, normalizedStatus };
  }
  if (normalizedStatus === "pause" || normalizedStatus === "paused") {
    return { ok: true, cmdLabel: RALPH_LABEL_CMD_PAUSE, normalizedStatus };
  }
  if (normalizedStatus === "stop" || normalizedStatus === "stopped") {
    return { ok: true, cmdLabel: RALPH_LABEL_CMD_STOP, normalizedStatus };
  }
  if (normalizedStatus === "satisfy" || normalizedStatus === "satisfied") {
    return { ok: true, cmdLabel: RALPH_LABEL_CMD_SATISFY, normalizedStatus };
  }

  return {
    ok: false,
    error: {
      code: "bad_request",
      message: `Unsupported status '${rawStatus.trim()}'`,
    },
  };
}

export function parseGitHubTaskId(taskId: string):
  | { ok: true; repo: string; issueNumber: number; issueRef: string }
  | { ok: false; error: TaskCommandValidationError } {
  const trimmed = taskId.trim();
  if (!trimmed) {
    return { ok: false, error: { code: "bad_request", message: "Missing taskId" } };
  }

  if (!trimmed.toLowerCase().startsWith("github:")) {
    return {
      ok: false,
      error: { code: "unsupported_task_id", message: "Only github taskIds are supported" },
    };
  }

  const rawIssueRef = trimmed.slice("github:".length).trim();
  const parsed = parseIssueRef(rawIssueRef, "");
  if (!parsed) {
    return {
      ok: false,
      error: {
        code: "bad_request",
        message: "Invalid github taskId; expected github:owner/repo#123",
      },
    };
  }

  return {
    ok: true,
    repo: parsed.repo,
    issueNumber: parsed.number,
    issueRef: `${parsed.repo}#${parsed.number}`,
  };
}

export function buildTaskStatusCmdLabelMutation(target: TaskCommandLabel): { add: string[]; remove: string[] } {
  return {
    add: [target],
    remove: TASK_COMMAND_LABELS.filter((label) => label !== target),
  };
}
