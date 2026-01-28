import { RALPH_LABEL_IN_BOT, RALPH_LABEL_IN_PROGRESS } from "./github-labels";
import { computeMidpointLabelPlan } from "./midpoint-labels";
import type { IssueRef } from "./github/issue-ref";
import type { ErrorNotificationContext } from "./notify";

const MIDPOINT_LABEL_TIMEOUT_MS = 10_000;

export type MidpointLabelerInput = {
  issueRef: IssueRef;
  issue: string;
  taskName?: string | null;
  prUrl: string;
  botBranch: string;
  baseBranch?: string | null;
  fetchDefaultBranch: () => Promise<string | null>;
  fetchBaseBranch: (prUrl: string) => Promise<string | null>;
  addIssueLabel: (issue: IssueRef, label: string) => Promise<void>;
  removeIssueLabel: (issue: IssueRef, label: string) => Promise<void>;
  notifyError: (title: string, body: string, context?: ErrorNotificationContext) => Promise<void>;
  warn?: (message: string) => void;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function applyMidpointLabelsBestEffort(input: MidpointLabelerInput): Promise<void> {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  let baseBranch = input.baseBranch ?? "";

  if (!baseBranch) {
    try {
      baseBranch =
        (await withTimeout(
          input.fetchBaseBranch(input.prUrl),
          MIDPOINT_LABEL_TIMEOUT_MS,
          "fetch base branch"
        )) ?? "";
    } catch (error: any) {
      warn(`Failed to re-check PR base before midpoint labeling: ${error?.message ?? String(error)}`);
    }
  }

  // Avoid blocking midpoint label cleanup on fetching the repo default branch.
  // The default-branch lookup is network-bound and may be rate-limited; when it fails
  // we prefer a conservative heuristic over stalling merges.
  const resolvedDefaultBranch = "";

  const plan = computeMidpointLabelPlan({
    baseBranch,
    botBranch: input.botBranch,
    defaultBranch: resolvedDefaultBranch,
  });
  if (!plan.addInBot && !plan.removeInProgress) return;

  const errors: string[] = [];

  if (plan.addInBot) {
    try {
      await withTimeout(
        input.addIssueLabel(input.issueRef, RALPH_LABEL_IN_BOT),
        MIDPOINT_LABEL_TIMEOUT_MS,
        `add ${RALPH_LABEL_IN_BOT}`
      );
    } catch (error: any) {
      const message = error?.message ?? String(error);
      errors.push(`add ${RALPH_LABEL_IN_BOT}: ${message}`);
      warn(`Failed to add ${RALPH_LABEL_IN_BOT} label: ${message}`);
    }
  }

  if (plan.removeInProgress) {
    try {
      await withTimeout(
        input.removeIssueLabel(input.issueRef, RALPH_LABEL_IN_PROGRESS),
        MIDPOINT_LABEL_TIMEOUT_MS,
        `remove ${RALPH_LABEL_IN_PROGRESS}`
      );
    } catch (error: any) {
      const message = error?.message ?? String(error);
      errors.push(`remove ${RALPH_LABEL_IN_PROGRESS}: ${message}`);
      warn(`Failed to remove ${RALPH_LABEL_IN_PROGRESS} label: ${message}`);
    }
  }

  if (errors.length > 0) {
    const body = [
      "Failed to update midpoint labels.",
      "",
      `Issue: ${input.issue}`,
      `PR: ${input.prUrl}`,
      "",
      "Errors:",
      errors.map((entry) => `- ${entry}`).join("\n"),
    ].join("\n");
    try {
      await withTimeout(
        input.notifyError("Midpoint label update failed", body, {
          taskName: input.taskName ?? undefined,
          repo: input.issueRef.repo,
          issue: input.issue,
        }),
        MIDPOINT_LABEL_TIMEOUT_MS,
        "notify midpoint label failure"
      );
    } catch (error: any) {
      warn(`Failed to notify midpoint label error: ${error?.message ?? String(error)}`);
    }
  }
}
