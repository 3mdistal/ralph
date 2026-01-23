import { RALPH_LABEL_IN_BOT, RALPH_LABEL_IN_PROGRESS } from "./github-labels";
import { computeMidpointLabelPlan } from "./midpoint-labels";
import type { IssueRef } from "./github/issue-blocking-core";

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
  notifyError: (title: string, body: string, taskName?: string | null) => Promise<void>;
  warn?: (message: string) => void;
};

export async function applyMidpointLabelsBestEffort(input: MidpointLabelerInput): Promise<void> {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  let baseBranch = input.baseBranch ?? "";
  let defaultBranch: string | null = null;

  try {
    defaultBranch = await input.fetchDefaultBranch();
  } catch (error: any) {
    warn(`Failed to fetch default branch for midpoint labels: ${error?.message ?? String(error)}`);
  }

  const resolvedDefaultBranch = defaultBranch ?? "";

  if (!baseBranch) {
    try {
      baseBranch = (await input.fetchBaseBranch(input.prUrl)) ?? "";
    } catch (error: any) {
      warn(`Failed to re-check PR base before midpoint labeling: ${error?.message ?? String(error)}`);
    }
  }

  const plan = computeMidpointLabelPlan({
    baseBranch,
    botBranch: input.botBranch,
    defaultBranch: resolvedDefaultBranch,
  });
  if (!plan.addInBot && !plan.removeInProgress) return;

  const errors: string[] = [];

  if (plan.addInBot) {
    try {
      await input.addIssueLabel(input.issueRef, RALPH_LABEL_IN_BOT);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      errors.push(`add ${RALPH_LABEL_IN_BOT}: ${message}`);
      warn(`Failed to add ${RALPH_LABEL_IN_BOT} label: ${message}`);
    }
  }

  if (plan.removeInProgress) {
    try {
      await input.removeIssueLabel(input.issueRef, RALPH_LABEL_IN_PROGRESS);
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
      await input.notifyError("Midpoint label update failed", body, input.taskName ?? undefined);
    } catch (error: any) {
      warn(`Failed to notify midpoint label error: ${error?.message ?? String(error)}`);
    }
  }
}
