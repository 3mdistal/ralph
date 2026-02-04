import { RALPH_LABEL_STATUS_BLOCKED, RALPH_LABEL_STATUS_IN_PROGRESS } from "../github-labels";
import { executeIssueLabelOps, type LabelOp } from "../github/issue-label-io";
import { formatIssueRef, type IssueRef } from "../github/issue-ref";
import { getIssueLabels, recordIssueLabelsSnapshot } from "../state";

export async function ensureRalphWorkflowLabelsOnce(worker: any): Promise<void> {
  await worker.labelEnsurer.ensure(worker.repo);
}

export async function addIssueLabel(worker: any, issue: IssueRef, label: string): Promise<void> {
  const result = await executeIssueLabelOps({
    github: worker.github,
    repo: issue.repo,
    issueNumber: issue.number,
    ops: [{ action: "add", label } satisfies LabelOp],
    log: (message: string) => console.warn(`[ralph:worker:${worker.repo}] ${message}`),
    logLabel: `${issue.repo}#${issue.number}`,
    ensureLabels: async () => await worker.labelEnsurer.ensure(issue.repo),
    retryMissingLabelOnce: true,
    ensureBefore: true,
  });
  if (!result.ok) {
    if (result.kind === "policy") {
      console.warn(`[ralph:worker:${worker.repo}] ${String(result.error)}`);
      return;
    }
    if (result.kind === "transient") {
      console.warn(`[ralph:worker:${worker.repo}] GitHub label write skipped (transient): ${String(result.error)}`);
      return;
    }
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }

  if (result.add.length > 0 || result.remove.length > 0) {
    worker.recordIssueLabelDelta(issue, { add: result.add, remove: result.remove });
  }
}

export async function removeIssueLabel(worker: any, issue: IssueRef, label: string): Promise<void> {
  const result = await executeIssueLabelOps({
    github: worker.github,
    repo: issue.repo,
    issueNumber: issue.number,
    ops: [{ action: "remove", label } satisfies LabelOp],
    log: (message: string) => console.warn(`[ralph:worker:${worker.repo}] ${message}`),
    logLabel: `${issue.repo}#${issue.number}`,
    ensureLabels: async () => await worker.labelEnsurer.ensure(issue.repo),
    retryMissingLabelOnce: true,
    ensureBefore: true,
  });
  if (!result.ok) {
    if (result.kind === "policy") {
      console.warn(`[ralph:worker:${worker.repo}] ${String(result.error)}`);
      return;
    }
    if (result.kind === "transient") {
      console.warn(`[ralph:worker:${worker.repo}] GitHub label write skipped (transient): ${String(result.error)}`);
      return;
    }
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }

  if (result.add.length > 0 || result.remove.length > 0) {
    worker.recordIssueLabelDelta(issue, { add: result.add, remove: result.remove });
  }
}

export function recordIssueLabelDelta(worker: any, issue: IssueRef, delta: { add: string[]; remove: string[] }): void {
  try {
    const nowIso = new Date().toISOString();
    const current = getIssueLabels(issue.repo, issue.number);
    const set = new Set(current);
    for (const label of delta.remove) set.delete(label);
    for (const label of delta.add) set.add(label);
    recordIssueLabelsSnapshot({ repo: issue.repo, issue: `${issue.repo}#${issue.number}`, labels: Array.from(set), at: nowIso });
  } catch (error: any) {
    console.warn(
      `[ralph:worker:${worker.repo}] Failed to record label snapshot for ${formatIssueRef(issue)}: ${
        error?.message ?? String(error)
      }`
    );
  }
}

export async function applyCiDebugLabels(worker: any, issue: IssueRef): Promise<void> {
  try {
    await worker.addIssueLabel(issue, RALPH_LABEL_STATUS_IN_PROGRESS);
  } catch (error: any) {
    console.warn(
      `[ralph:worker:${worker.repo}] Failed to add ${RALPH_LABEL_STATUS_IN_PROGRESS} label for ${formatIssueRef(issue)}: ${
        error?.message ?? String(error)
      }`
    );
  }

  try {
    await worker.removeIssueLabel(issue, RALPH_LABEL_STATUS_BLOCKED);
  } catch (error: any) {
    console.warn(
      `[ralph:worker:${worker.repo}] Failed to remove ${RALPH_LABEL_STATUS_BLOCKED} label for ${formatIssueRef(issue)}: ${
        error?.message ?? String(error)
      }`
    );
  }
}

export async function clearCiDebugLabels(worker: any, issue: IssueRef): Promise<void> {
  try {
    await worker.removeIssueLabel(issue, RALPH_LABEL_STATUS_IN_PROGRESS);
  } catch (error: any) {
    console.warn(
      `[ralph:worker:${worker.repo}] Failed to remove ${RALPH_LABEL_STATUS_IN_PROGRESS} label for ${formatIssueRef(issue)}: ${
        error?.message ?? String(error)
      }`
    );
  }
}
