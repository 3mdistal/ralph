import { $ } from "bun";
import { existsSync } from "fs";
import { readFile, rm } from "fs/promises";

import { getRepoLoopDetectionConfig } from "../../config";
import type { AgentTask } from "../../queue-backend";
import type { SessionResult } from "../../session";
import { redactSensitiveText } from "../../redaction";
import { sanitizeEscalationReason } from "../../github/escalation-writeback";
import { buildLoopTripDetails } from "../../loop-detection/format";
import type { EscalationContext } from "../../notify";
import { computeLoopTriageSignature, decideLoopTripAction, parseLoopTriageMarker } from "../../loop-triage/core";
import { getSessionEventsPath } from "../../paths";
import { isSafeSessionId } from "../../session-id";
import { bumpLoopTriageAttempt, getLoopTriageAttempt, shouldAllowLoopTriageAttempt } from "../../state";
import { summarizeRequiredChecks, type PrCheck } from "./required-checks";

const LOOP_TRIAGE_EVENTS_LIMIT = 30;
const LOOP_TRIAGE_LOG_LINES_LIMIT = 40;
const LOOP_TRIAGE_NUDGE_MAX_CHARS = 600;

export type LoopTripLaneResult = {
  taskName: string;
  repo: string;
  outcome: "success" | "failed" | "escalated";
  sessionId?: string;
  escalationReason?: string;
};

export async function readLoopTriageEvents(params: { sessionId: string; limit: number }): Promise<string[]> {
  if (!params.sessionId.trim() || !isSafeSessionId(params.sessionId)) return [];
  try {
    const raw = await readFile(getSessionEventsPath(params.sessionId), "utf8");
    const rows = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const selected: string[] = [];

    for (const line of rows) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object") continue;
        const event = parsed as Record<string, unknown>;
        const type = String(event.type ?? "");
        if (!["tool-start", "step-start", "run-start", "tool-end", "loop-trip"].includes(type)) continue;
        selected.push(
          sanitizeEscalationReason(
            redactSensitiveText(
              JSON.stringify({
                type,
                ts: event.ts,
                step: event.step,
                title: event.title,
                toolName: event.toolName,
                argsPreview: event.argsPreview,
                callId: event.callId,
              })
            )
          )
        );
      } catch {
        // ignore malformed lines
      }
    }

    return selected.slice(Math.max(0, selected.length - params.limit));
  } catch {
    return [];
  }
}

export async function readLoopTriageLogTail(params: { path: string | undefined; maxLines: number }): Promise<string[]> {
  const filePath = params.path?.trim();
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const tail = lines.slice(Math.max(0, lines.length - params.maxLines));
    return tail.map((line) => sanitizeEscalationReason(redactSensitiveText(line))).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildLoopTriagePrompt(params: { stage: string; bundle: string; recommendedGateCommand: string }): string {
  const gate = params.recommendedGateCommand.trim() || "bun test";
  return [
    "Loop triage prompt v1",
    "Decide the safest next action after loop detection tripped.",
    "Prefer progress: restart/resume if plausible, escalate only when needed.",
    "",
    `Stage: ${params.stage}`,
    `Recommended deterministic gate: ${gate}`,
    "",
    "Compact context bundle:",
    params.bundle,
    "",
    "Output instructions:",
    "- Return concise reasoning.",
    "- Final line must be exactly one marker:",
    'RALPH_LOOP_TRIAGE: {"version":1,"decision":"resume-existing|restart-new-agent|restart-ci-debug|escalate","rationale":"...","nudge":"..."}',
  ].join("\n");
}

export async function runLoopTripLane(params: {
  repo: string;
  repoPath: string;
  task: AgentTask;
  cacheKey: string;
  stage: string;
  result: SessionResult;
  readLoopTriageEvents: (sessionId: string, limit: number) => Promise<string[]>;
  readLoopTriageLogTail: (path: string | undefined, maxLines: number) => Promise<string[]>;
  buildLoopTriagePrompt: (args: { stage: string; bundle: string; recommendedGateCommand: string }) => string;
  getIssuePrResolution: (issueNumber: string) => Promise<{ selectedUrl: string | null }>;
  resolveRequiredChecksForMerge: () => Promise<{ checks: string[] }>;
  getPullRequestChecks: (prUrl: string) => Promise<{ checks: PrCheck[] }>;
  resolveLoopTriageAttempts: () => number;
  updateTaskStatus: (task: AgentTask, status: AgentTask["status"], fields: Record<string, string>) => Promise<boolean>;
  applyTaskPatch: (task: AgentTask, status: AgentTask["status"], fields: Record<string, string>) => void;
  runLoopTriageAgent: (repoPath: string, prompt: string, args: {
    repo: string;
    cacheKey: string;
    issue: string;
    taskName: string;
  }) => Promise<{ success: boolean; output: string }>;
  getRalphXdgCacheHome: (repo: string, cacheKey: string) => string;
  formatGhError: (error: unknown) => string;
  writeEscalationWriteback: (task: AgentTask, args: { reason: string; details?: string; escalationType: "other" }) => Promise<string | null>;
  notifyEscalation: (args: {
    taskName: EscalationContext["taskName"];
    taskFileName: EscalationContext["taskFileName"];
    taskPath: EscalationContext["taskPath"];
    issue: EscalationContext["issue"];
    repo: EscalationContext["repo"];
    scope: EscalationContext["scope"];
    priority: EscalationContext["priority"];
    sessionId: EscalationContext["sessionId"];
    reason: EscalationContext["reason"];
    escalationType: "other";
    githubCommentUrl: EscalationContext["githubCommentUrl"];
    planOutput: EscalationContext["planOutput"];
  }) => Promise<boolean | void>;
  recordEscalatedRunNote: (task: AgentTask, args: { reason: string; sessionId?: string; details?: string }) => Promise<void>;
}): Promise<LoopTripLaneResult> {
  const { task, result, stage, cacheKey } = params;
  const trip = result.loopTrip;
  const sessionId = result.sessionId || task["session-id"]?.trim() || "";
  const worktreePath = task["worktree-path"]?.trim() || "";
  const issueMatch = task.issue.match(/#(\d+)$/);
  const issueNumber = issueMatch?.[1] ?? "";

  const reason = trip ? `Loop detection tripped: ${trip.reason} (${stage})` : `Loop detection tripped (${stage})`;

  let fallbackTouchedFiles: string[] | null = null;
  if (trip && trip.metrics.topFiles.length === 0 && worktreePath) {
    try {
      const names = (await $`git diff --name-only`.cwd(worktreePath).quiet()).stdout
        .toString()
        .split("\n")
        .map((value: string) => value.trim())
        .filter(Boolean);
      fallbackTouchedFiles = names.slice(0, 10);
    } catch {
      // ignore
    }
  }

  const loopCfg = getRepoLoopDetectionConfig(params.repo);
  const recommendedGateCommand = loopCfg?.recommendedGateCommand ?? "bun test";
  const loopDetails =
    trip != null
      ? buildLoopTripDetails({
          trip,
          recommendedGateCommand,
          lastDiagnosticSnippet: result.output,
          fallbackTouchedFiles,
        })
      : "";

  const eventTail = await params.readLoopTriageEvents(sessionId, LOOP_TRIAGE_EVENTS_LIMIT);
  const runLogTail = await params.readLoopTriageLogTail(task["run-log-path"], LOOP_TRIAGE_LOG_LINES_LIMIT);
  const fallbackOutputTail = result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-LOOP_TRIAGE_LOG_LINES_LIMIT)
    .map((line) => sanitizeEscalationReason(redactSensitiveText(line)));

  let prSnapshot = "PR status: (no open PR detected)";
  let deterministicCiDebug = false;
  try {
    if (issueNumber) {
      const existingPr = await params.getIssuePrResolution(issueNumber);
      if (existingPr.selectedUrl) {
        const { checks: requiredChecks } = await params.resolveRequiredChecksForMerge();
        const prStatus = await params.getPullRequestChecks(existingPr.selectedUrl);
        const summary = summarizeRequiredChecks(prStatus.checks, requiredChecks);
        deterministicCiDebug = summary.status === "failure";
        const lines = summary.required.slice(0, 8).map((check) => {
          const detailsUrl = check.detailsUrl ? ` (${check.detailsUrl})` : "";
          return `- ${check.name}: ${check.rawState}${detailsUrl}`;
        });
        prSnapshot = [
          `PR: ${existingPr.selectedUrl}`,
          `Required checks: ${summary.status}`,
          ...(lines.length > 0 ? lines : ["- (no required checks configured)"]),
        ].join("\n");
      }
    }
  } catch (error: unknown) {
    prSnapshot = `PR status lookup failed: ${params.formatGhError(error)}`;
  }

  const signature = computeLoopTriageSignature({ stage, trip });
  const maxAttempts = params.resolveLoopTriageAttempts();
  const issueNumberValue = Number.parseInt(issueNumber, 10);
  const priorAttempt =
    issueNumber && Number.isFinite(issueNumberValue)
      ? getLoopTriageAttempt({ repo: params.repo, issueNumber: issueNumberValue, signature })
      : null;
  const priorAttempts = priorAttempt?.attemptCount ?? 0;

  const bundle = sanitizeEscalationReason(
    [
      loopDetails || "Loop details unavailable.",
      "",
      "Recent events (bounded):",
      ...(eventTail.length > 0 ? eventTail.map((line) => `- ${line}`) : ["- (none captured)"]),
      "",
      "Recent stderr/output tail (bounded):",
      ...((runLogTail.length > 0 ? runLogTail : fallbackOutputTail).map((line) => `- ${line}`)),
      "",
      prSnapshot,
    ].join("\n")
  );

  let parseResult = parseLoopTriageMarker(
    'RALPH_LOOP_TRIAGE: {"version":1,"decision":"escalate","rationale":"deterministic default","nudge":"escalate"}'
  );
  if (!deterministicCiDebug) {
    const prompt = params.buildLoopTriagePrompt({ stage, bundle, recommendedGateCommand });
    const triageRepoPath = existsSync(worktreePath) ? worktreePath : params.repoPath;
    const triageResult = await params.runLoopTriageAgent(triageRepoPath, prompt, {
      repo: params.repo,
      cacheKey,
      issue: task.issue,
      taskName: task.name,
    });
    parseResult = parseLoopTriageMarker(triageResult.output);
    if (!triageResult.success && !parseResult.ok) {
      parseResult = { ok: false, error: `Loop triage run failed: ${sanitizeEscalationReason(triageResult.output)}` };
    }
  }

  const decision = decideLoopTripAction({
    deterministicCiDebug,
    parse: parseResult,
    priorAttempts,
    maxAttempts,
    canResumeExisting: Boolean(sessionId),
  });

  if (decision.action !== "escalate") {
    const nowIso = new Date().toISOString();
    if (issueNumber && Number.isFinite(issueNumberValue)) {
      const nextAttempt = bumpLoopTriageAttempt({
        repo: params.repo,
        issueNumber: issueNumberValue,
        signature,
        decision: decision.action,
        rationale: decision.rationale,
      });
      if (!shouldAllowLoopTriageAttempt(nextAttempt.attemptCount, maxAttempts)) {
        decision.action = "escalate";
        decision.reasonCode = "budget_exhausted";
        decision.rationale = `Loop-triage budget exhausted (${nextAttempt.attemptCount}/${maxAttempts})`;
      }
    }

    if (decision.action === "resume-existing") {
      const nudge = decision.nudge.slice(0, LOOP_TRIAGE_NUDGE_MAX_CHARS);
      const details = sanitizeEscalationReason(bundle.slice(0, 1200));
      await params.updateTaskStatus(task, "queued", {
        "session-id": sessionId,
        "blocked-source": "loop-triage",
        "blocked-reason": decision.rationale,
        "blocked-details": `${nudge}\n\n${details}`,
        "blocked-at": nowIso,
        "blocked-checked-at": nowIso,
      });
      try {
        await rm(params.getRalphXdgCacheHome(params.repo, cacheKey), { recursive: true, force: true });
      } catch {
        // ignore
      }
      return {
        taskName: task.name,
        repo: params.repo,
        outcome: "failed",
        sessionId: sessionId || undefined,
        escalationReason: `Loop triage: ${decision.action} (${decision.reasonCode})`,
      };
    }

    await params.updateTaskStatus(task, "queued", {
      "session-id": "",
      "blocked-source": "",
      "blocked-reason": "",
      "blocked-details": "",
      "blocked-at": "",
      "blocked-checked-at": "",
    });
    try {
      await rm(params.getRalphXdgCacheHome(params.repo, cacheKey), { recursive: true, force: true });
    } catch {
      // ignore
    }
    return {
      taskName: task.name,
      repo: params.repo,
      outcome: "failed",
      sessionId: sessionId || undefined,
      escalationReason: `Loop triage: ${decision.action} (${decision.reasonCode})`,
    };
  }

  const escalateReason = `${reason}; triage=${decision.action} code=${decision.reasonCode}`;
  const details = sanitizeEscalationReason(
    [
      loopDetails,
      "",
      `Triage decision: ${decision.action}`,
      `Triage rationale: ${decision.rationale}`,
      `Triage source: ${decision.source}`,
      `Signature: ${signature}`,
      `Attempts: ${priorAttempts}/${maxAttempts}`,
      decision.parseError ? `Parse error: ${decision.parseError}` : "",
      "",
      "Context bundle (bounded):",
      bundle,
    ]
      .filter(Boolean)
      .join("\n")
  );

  const escalationFields: Record<string, string> = {};
  if (sessionId) escalationFields["session-id"] = sessionId;

  const wasEscalated = task.status === "escalated";
  const escalated = await params.updateTaskStatus(task, "escalated", escalationFields);
  if (escalated) {
    params.applyTaskPatch(task, "escalated", escalationFields);
  }

  const githubCommentUrl = await params.writeEscalationWriteback(task, {
    reason: escalateReason,
    details,
    escalationType: "other",
  });

  await params.notifyEscalation({
    taskName: task.name,
    taskFileName: task._name,
    taskPath: task._path,
    issue: task.issue,
    repo: params.repo,
    scope: task.scope,
    priority: task.priority,
    sessionId: sessionId || undefined,
    reason: escalateReason,
    escalationType: "other",
    githubCommentUrl: githubCommentUrl ?? undefined,
    planOutput: result.output,
  });

  if (escalated && !wasEscalated) {
    await params.recordEscalatedRunNote(task, {
      reason: escalateReason,
      sessionId: sessionId || undefined,
      details,
    });
  }

  try {
    await rm(params.getRalphXdgCacheHome(params.repo, cacheKey), { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    taskName: task.name,
    repo: params.repo,
    outcome: "escalated",
    sessionId: sessionId || undefined,
    escalationReason: escalateReason,
  };
}
