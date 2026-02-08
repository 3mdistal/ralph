import type { EnsureOutcome } from "../github/ensure-ralph-workflow-labels";
import { executeIssueLabelOps, planIssueLabelOps, type ApplyIssueLabelOpsResult } from "../github/issue-label-io";
import {
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_CMD_SATISFY,
  RALPH_LABEL_CMD_STOP,
} from "../github-labels";
import { normalizePriorityInputToRalphPriorityLabel, planRalphPriorityLabelSet } from "../queue/priority";
import type { GitHubClient } from "../github/client";
import { ControlPlaneHttpError } from "./control-plane-errors";

const ISSUE_COMMANDS = ["queue", "pause", "stop", "satisfy"] as const;
export type IssueCommandName = (typeof ISSUE_COMMANDS)[number];

const ISSUE_COMMAND_LABEL_BY_NAME: Record<IssueCommandName, string> = {
  queue: RALPH_LABEL_CMD_QUEUE,
  pause: RALPH_LABEL_CMD_PAUSE,
  stop: RALPH_LABEL_CMD_STOP,
  satisfy: RALPH_LABEL_CMD_SATISFY,
};

const ISSUE_COMMAND_LABELS = Object.values(ISSUE_COMMAND_LABEL_BY_NAME);

export function isIssueCommandName(value: unknown): value is IssueCommandName {
  return value === "queue" || value === "pause" || value === "stop" || value === "satisfy";
}

export function issueCommandLabel(cmd: IssueCommandName): string {
  return ISSUE_COMMAND_LABEL_BY_NAME[cmd];
}

export function planIssuePriorityOps(priorityInput: string): { canonicalLabel: string; ops: ReturnType<typeof planIssueLabelOps> } {
  const canonicalLabel = normalizePriorityInputToRalphPriorityLabel(priorityInput);
  const labelPlan = planRalphPriorityLabelSet(canonicalLabel);
  return {
    canonicalLabel,
    ops: planIssueLabelOps({ add: labelPlan.add, remove: labelPlan.remove }),
  };
}

export function planIssueCmdOps(cmd: IssueCommandName): { label: string; ops: ReturnType<typeof planIssueLabelOps> } {
  const label = issueCommandLabel(cmd);
  return {
    label,
    ops: planIssueLabelOps({
      add: [label],
      remove: ISSUE_COMMAND_LABELS.filter((candidate) => candidate !== label),
    }),
  };
}

function throwForLabelOpsFailure(result: Exclude<ApplyIssueLabelOpsResult, { ok: true }>): never {
  const message = result.error instanceof Error ? result.error.message : String(result.error);
  if (result.kind === "policy") {
    throw new ControlPlaneHttpError(400, "github_label_policy", `Refused label operation: ${message}`);
  }
  if (result.kind === "auth") {
    throw new ControlPlaneHttpError(403, "github_auth", `GitHub authorization failed: ${message}`);
  }
  if (result.kind === "transient") {
    throw new ControlPlaneHttpError(503, "github_transient", `GitHub label write temporarily unavailable: ${message}`);
  }
  throw new ControlPlaneHttpError(502, "github_unknown", `GitHub label write failed: ${message}`);
}

type ExecuteIssueLabelCommandParams = {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  ops: ReturnType<typeof planIssueLabelOps>;
  ensureLabels: () => Promise<EnsureOutcome>;
};

async function executeIssueLabelCommand(params: ExecuteIssueLabelCommandParams): Promise<void> {
  const result = await executeIssueLabelOps({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    ops: params.ops,
    ensureLabels: params.ensureLabels,
    ensureBefore: true,
    retryMissingLabelOnce: true,
  });
  if (!result.ok) throwForLabelOpsFailure(result);
}

export async function applyIssuePriority(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  priority: string;
  ensureLabels: () => Promise<EnsureOutcome>;
}): Promise<{ canonicalLabel: string }> {
  const planned = planIssuePriorityOps(params.priority);
  await executeIssueLabelCommand({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    ops: planned.ops,
    ensureLabels: params.ensureLabels,
  });
  return { canonicalLabel: planned.canonicalLabel };
}

export async function applyIssueCommand(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  cmd: IssueCommandName;
  ensureLabels: () => Promise<EnsureOutcome>;
}): Promise<{ label: string }> {
  const planned = planIssueCmdOps(params.cmd);
  await executeIssueLabelCommand({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    ops: planned.ops,
    ensureLabels: params.ensureLabels,
  });
  return { label: planned.label };
}
