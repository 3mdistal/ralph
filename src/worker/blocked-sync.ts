import type { AgentTask } from "../queue-backend";
import { setParentVerificationPending, getIssueLabels, isStateDbInitialized } from "../state";
import { computeBlockedDecision } from "../github/issue-blocking-core";
import { formatIssueRef, parseIssueRef } from "../github/issue-ref";
import { RALPH_LABEL_STATUS_BLOCKED, RALPH_LABEL_STATUS_QUEUED } from "../github-labels";

const BLOCKED_SYNC_INTERVAL_MS = 30_000;

export async function syncBlockedStateForTasks(worker: any, tasks: AgentTask[]): Promise<Set<string>> {
  const blockedPaths = new Set<string>();
  if (tasks.length === 0) return blockedPaths;

  const now = Date.now();
  const allowRefresh = now - (worker.lastBlockedSyncAt ?? 0) >= BLOCKED_SYNC_INTERVAL_MS;
  if (allowRefresh) {
    worker.lastBlockedSyncAt = now;
  }

  const byIssue = new Map<string, { issue: { repo: string; number: number }; tasks: AgentTask[] }>();
  for (const task of tasks) {
    const issueRef = parseIssueRef(task.issue, task.repo);
    if (!issueRef) continue;
    const key = `${issueRef.repo}#${issueRef.number}`;
    const entry = byIssue.get(key) ?? { issue: issueRef, tasks: [] };
    entry.tasks.push(task);
    byIssue.set(key, entry);
  }

  for (const entry of byIssue.values()) {
    const labelsKnown = isStateDbInitialized();
    const issueLabels = getIssueLabels(entry.issue.repo, entry.issue.number);
    const snapshot = await worker.getRelationshipSnapshot(entry.issue, allowRefresh);
    if (!snapshot) continue;

    const signals = worker.buildRelationshipSignals(snapshot);
    const decision = computeBlockedDecision(signals);

    if (decision.blocked && decision.confidence === "certain") {
      for (const task of entry.tasks) {
        if (task.status !== "blocked" && task._path) blockedPaths.add(task._path);
        const isBlockedForOtherReason =
          task.status === "blocked" && task["blocked-source"] && task["blocked-source"] !== "deps";
        if (isBlockedForOtherReason) continue;
        const reason = decision.reasons.join("; ") || "blocked by dependencies";
        await worker.markTaskBlocked(task, "deps", { reason, details: reason });
      }

      const hasBlockedLabel = issueLabels.some((label) => label.trim().toLowerCase() === RALPH_LABEL_STATUS_BLOCKED);
      if (!labelsKnown || !hasBlockedLabel) {
        try {
          await worker.addIssueLabel(entry.issue, RALPH_LABEL_STATUS_BLOCKED);
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${worker.repo}] Failed to add ${RALPH_LABEL_STATUS_BLOCKED} label: ${error?.message ?? String(error)}`
          );
        }
      }
      continue;
    }

    if (!decision.blocked && decision.confidence === "certain") {
      const labels = issueLabels;
      const shouldSetParentVerification =
        labels.length === 0 ? true : labels.some((label) => label.trim().toLowerCase() === RALPH_LABEL_STATUS_QUEUED);
      let shouldRemoveBlockedLabel = true;
      for (const task of entry.tasks) {
        if (task.status !== "blocked") continue;
        if (task["blocked-source"] !== "deps") {
          shouldRemoveBlockedLabel = false;
          continue;
        }
        const unblocked = await worker.markTaskUnblocked(task);
        if (!unblocked) {
          shouldRemoveBlockedLabel = false;
        } else {
          if (shouldSetParentVerification) {
            const didSet = setParentVerificationPending({
              repo: worker.repo,
              issueNumber: entry.issue.number,
              nowMs: now,
            });
            if (didSet) {
              console.log(
                `[ralph:worker:${worker.repo}] Parent verification pending for ${formatIssueRef(entry.issue)}`
              );
            }
          }
        }
      }

      if (shouldRemoveBlockedLabel) {
        const hasBlockedLabel = issueLabels.some((label) => label.trim().toLowerCase() === RALPH_LABEL_STATUS_BLOCKED);
        if (!labelsKnown || hasBlockedLabel) {
          try {
            await worker.removeIssueLabel(entry.issue, RALPH_LABEL_STATUS_BLOCKED);
          } catch (error: any) {
            console.warn(
              `[ralph:worker:${worker.repo}] Failed to remove ${RALPH_LABEL_STATUS_BLOCKED} label: ${error?.message ?? String(error)}`
            );
          }
        }
      }
    }
  }

  return blockedPaths;
}
