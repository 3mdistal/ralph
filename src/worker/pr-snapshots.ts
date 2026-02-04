import type { AgentTask } from "../queue-backend";

import { recordPrSnapshot, PR_STATE_OPEN, type PrState } from "../state";

export function recordPrSnapshotBestEffort(
  params: { repo: string },
  input: { issue: string; prUrl: string; state: PrState }
): void {
  try {
    recordPrSnapshot({ repo: params.repo, issue: input.issue, prUrl: input.prUrl, state: input.state });
  } catch (error: any) {
    console.warn(`[ralph:worker:${params.repo}] Failed to record PR snapshot: ${error?.message ?? String(error)}`);
  }
}

export function updateOpenPrSnapshot(
  params: { repo: string },
  task: AgentTask,
  currentPrUrl: string | null,
  nextPrUrl: string | null
): string | null {
  if (!nextPrUrl) return currentPrUrl;
  if (nextPrUrl === currentPrUrl) return currentPrUrl;
  recordPrSnapshotBestEffort(params, { issue: task.issue, prUrl: nextPrUrl, state: PR_STATE_OPEN });
  return nextPrUrl;
}
