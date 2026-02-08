import { $ } from "bun";
import type { TaskPriority } from "./queue/priority";
import type { EscalationType } from "./github/escalation-constants";
import { recordIssueAlert, recordIssueErrorAlert, recordRepoErrorAlert, recordRollupReadyAlert } from "./alerts/service";
import { parseIssueRef } from "./github/issue-ref";

export type ErrorNotificationContext = {
  repo?: string | null;
  issue?: string | null;
  taskName?: string | null;
  alertOverride?: {
    fingerprintSeed: string;
    summary: string;
    details?: string | null;
  };
};

type ErrorNotificationInput = ErrorNotificationContext | string | null | undefined;

let terminalNotifierAvailable: boolean | null = null;

async function isTerminalNotifierAvailable(): Promise<boolean> {
  if (terminalNotifierAvailable !== null) {
    return terminalNotifierAvailable;
  }

  try {
    await $`which terminal-notifier`.quiet();
    terminalNotifierAvailable = true;
  } catch {
    terminalNotifierAvailable = false;
  }

  return terminalNotifierAvailable;
}

async function sendDesktopNotification(opts: {
  title: string;
  subtitle?: string;
  message: string;
  openUrl?: string;
  sound?: string;
}): Promise<boolean> {
  if (!(await isTerminalNotifierAvailable())) {
    return false;
  }

  try {
    const args: string[] = ["-title", opts.title, "-message", opts.message];
    if (opts.subtitle) args.push("-subtitle", opts.subtitle);
    if (opts.openUrl) args.push("-open", opts.openUrl);
    if (opts.sound) args.push("-sound", opts.sound);
    await $`terminal-notifier ${args}`.quiet();
    return true;
  } catch {
    return false;
  }
}

export interface EscalationContext {
  taskName: string;
  taskFileName: string;
  taskPath: string;
  issue: string;
  repo: string;
  scope?: string;
  priority?: TaskPriority;
  sessionId?: string;
  reason: string;
  escalationType: EscalationType;
  planOutput?: string;
  githubCommentUrl?: string;
  routing?: {
    decision: string;
    confidence?: string | null;
    escalation_reason?: string | null;
    plan_summary?: string | null;
  };
  devex?: {
    consulted: boolean;
    sessionId?: string;
    summary?: string;
  };
}

export async function notifyEscalation(ctx: EscalationContext): Promise<boolean> {
  const issueRef = parseIssueRef(ctx.issue, ctx.repo);
  if (issueRef) {
    try {
      await recordIssueAlert({
        repo: issueRef.repo,
        issueNumber: issueRef.number,
        taskName: ctx.taskName,
        kind: "error",
        fingerprintSeed: `escalation:${ctx.escalationType}:${ctx.reason}`,
        summary: `Escalation: ${ctx.reason}`,
        details: ctx.planOutput ?? null,
      });
    } catch (error: any) {
      console.warn(`[ralph:notify] Failed to record escalation alert: ${error?.message ?? String(error)}`);
    }
  }

  const issueUrl = ctx.githubCommentUrl ?? (issueRef ? `https://github.com/${issueRef.repo}/issues/${issueRef.number}` : undefined);
  await sendDesktopNotification({
    title: "Ralph: Escalation",
    subtitle: ctx.escalationType,
    message: `${ctx.taskName.slice(0, 80)}: ${ctx.reason.slice(0, 100)}`,
    openUrl: issueUrl,
    sound: "Ping",
  });

  return true;
}

export async function notifyRollupReady(repo: string, prUrl: string, mergedPRs: string[]): Promise<void> {
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)(?:$|\?)/);
  const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : null;

  try {
    await recordRollupReadyAlert({
      repo,
      prNumber: prNumber && Number.isFinite(prNumber) ? prNumber : null,
      prUrl,
      mergedPRs,
    });
  } catch (error: any) {
    console.warn(`[ralph:notify] Failed to record rollup-ready alert for ${repo}: ${error?.message ?? String(error)}`);
  }

  await sendDesktopNotification({
    title: "Ralph: Rollup Ready",
    subtitle: repo,
    message: `Rollup PR ready: ${prUrl}`.slice(0, 120),
    openUrl: prUrl,
    sound: "Ping",
  });
}

export async function notifyError(context: string, error: string, input?: ErrorNotificationInput): Promise<void> {
  const normalizedInput: ErrorNotificationContext | undefined =
    typeof input === "string" ? { taskName: input } : input ?? undefined;
  const taskName = normalizedInput?.taskName ?? undefined;
  const issueRaw = normalizedInput?.issue?.trim() ?? "";
  const issueRef = issueRaw ? parseIssueRef(issueRaw, normalizedInput?.repo ?? "") : null;

  if (issueRef) {
    try {
      const override = normalizedInput?.alertOverride;
      if (override) {
        await recordIssueAlert({
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          taskName: taskName ?? undefined,
          kind: "error",
          fingerprintSeed: override.fingerprintSeed,
          summary: override.summary,
          details: override.details ?? null,
        });
      } else {
        await recordIssueErrorAlert({
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          taskName: taskName ?? undefined,
          context,
          error,
        });
      }
    } catch (recordError: any) {
      console.warn(
        `[ralph:notify] Failed to record alert for ${issueRef.repo}#${issueRef.number}: ${recordError?.message ?? String(recordError)}`
      );
    }
  } else if (normalizedInput?.repo) {
    try {
      recordRepoErrorAlert({
        repo: normalizedInput.repo,
        context,
        error,
      });
    } catch (recordError: any) {
      console.warn(`[ralph:notify] Failed to record repo alert for ${normalizedInput.repo}: ${recordError?.message ?? String(recordError)}`);
    }
  }

  await sendDesktopNotification({
    title: "Ralph: Error",
    subtitle: taskName ?? "Task Error",
    message: `${context}: ${error.slice(0, 80)}`,
    sound: "Basso",
  });
}

export async function notifyTaskComplete(taskName: string, repo: string, prUrl?: string): Promise<void> {
  await sendDesktopNotification({
    title: "Ralph: Task Complete",
    subtitle: repo,
    message: `${taskName.slice(0, 60)}${prUrl ? " - PR created" : ""}`,
    openUrl: prUrl,
    sound: "Glass",
  });
}
