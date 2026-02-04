import type { AgentTask } from "../queue-backend";
import type { EscalationContext } from "../notify";

import { parseIssueRef } from "../github/issue-ref";
import { ensureEscalationCommentHasConsultantPacket } from "../github/escalation-consultant-writeback";
import { writeEscalationToGitHub } from "../github/escalation-writeback";

export async function writeEscalationWriteback(
  worker: any,
  task: AgentTask,
  params: { reason: string; details?: string; escalationType: EscalationContext["escalationType"] }
): Promise<string | null> {
  const escalationIssueRef = parseIssueRef(task.issue, task.repo);
  if (!escalationIssueRef) {
    console.warn(`[ralph:worker:${worker.repo}] Cannot parse issue ref for escalation writeback: ${task.issue}`);
    return null;
  }

  try {
    await worker.ensureRalphWorkflowLabelsOnce();
  } catch (error: any) {
    console.warn(
      `[ralph:worker:${worker.repo}] Failed to ensure ralph workflow labels before escalation writeback: ${
        error?.message ?? String(error)
      }`
    );
  }

  try {
    const result = await writeEscalationToGitHub(
      {
        repo: escalationIssueRef.repo,
        issueNumber: escalationIssueRef.number,
        taskName: task.name,
        taskPath: task._path ?? task.name,
        reason: params.reason,
        details: params.details,
        escalationType: params.escalationType,
      },
      {
        github: worker.github,
        log: (message) => console.log(message),
      }
    );
    const commentUrl = result.commentUrl ?? null;

    if (commentUrl) {
      try {
        const repoPath = task["worktree-path"]?.trim() || worker.repoPath;
        await ensureEscalationCommentHasConsultantPacket({
          github: worker.github,
          repo: escalationIssueRef.repo,
          escalationCommentUrl: commentUrl,
          repoPath,
          input: {
            issue: task.issue,
            repo: escalationIssueRef.repo,
            taskName: task.name,
            taskPath: task._path ?? task.name,
            escalationType: params.escalationType,
            reason: params.reason,
            sessionId: task["session-id"]?.trim() || null,
            githubCommentUrl: commentUrl,
          },
          log: (m) => console.log(m),
        });
      } catch (error: any) {
        console.warn(
          `[ralph:worker:${worker.repo}] Failed to attach consultant packet to escalation comment: ${
            error?.message ?? String(error)
          }`
        );
      }
    }

    return commentUrl;
  } catch (error: any) {
    console.warn(
      `[ralph:worker:${worker.repo}] Escalation writeback failed for ${task.issue}: ${error?.message ?? String(error)}`
    );
  }
  return null;
}
