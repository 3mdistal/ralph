import { existsSync } from "fs";

import { getRepoBotBranch } from "../../config";
import { isRepoAllowed } from "../../github-app-auth";
import { appendChildDossierToIssueContext } from "../../child-dossier/core";
import { buildPlannerPrompt } from "../../planner-prompt";
import { hasProductGap, parseRoutingDecision, selectPrUrl } from "../../routing";
import { isExplicitBlockerReason, isImplementationTaskFromIssue, shouldConsultDevex } from "../../escalation";
import { summarizeForNote } from "../run-notes";
import { parseIssueRef } from "../../github/issue-ref";
import { classifyOpencodeFailure } from "../../opencode-error-classifier";
import { deleteIdempotencyKey } from "../../state";
import { writeDxSurveyToGitHubIssues } from "../../github/dx-survey-writeback";
import { applyTaskPatch } from "../task-patch";
import { readLiveAnomalyCount } from "../introspection";
import type { AgentTask } from "../../queue-backend";
import type { EscalationContext } from "../../notify";
import type { AgentRun } from "../repo-worker";

type StartTaskOptions = { repoSlot?: number | null };

export type StartLaneDeps = any;

const ANOMALY_BURST_THRESHOLD = 50;
const MAX_ANOMALY_ABORTS = 3;
const PR_CREATE_CONFLICT_WAIT_MS = 2 * 60_000;

export async function runStartLane(deps: StartLaneDeps, task: AgentTask, opts?: StartTaskOptions): Promise<AgentRun> {
  return await (async function (this: StartLaneDeps): Promise<AgentRun> {
    const startTime = new Date();

    let workerId: string | undefined;
    let allocatedSlot: number | null = null;

    try {
      const issueMatch = task.issue.match(/#(\d+)$/);
      if (!issueMatch) throw new Error(`Invalid issue format: ${task.issue}`);
      const issueNumber = issueMatch[1];
      const cacheKey = issueNumber;

      if (!isRepoAllowed(task.repo)) {
        return await this.blockDisallowedRepo(task, startTime, "start");
      }

      const issueMeta = await this.getIssueMetadata(task.issue);
      if (issueMeta.state === "CLOSED") {
        return await this.skipClosedIssue(task, issueMeta, startTime);
      }

      workerId = await this.formatWorkerId(task, task._path);
      allocatedSlot = this.resolveAssignedRepoSlot(task, opts?.repoSlot);

      const pausedPreStart = await this.pauseIfHardThrottled(task, "pre-start");
      if (pausedPreStart) return pausedPreStart;

      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "start");
      if (resolvedOpencode.error) throw new Error(resolvedOpencode.error);

      const opencodeProfileName = resolvedOpencode.profileName;
      const opencodeXdg = resolvedOpencode.opencodeXdg;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      const parentVerifyRun = await this.maybeRunParentVerification({
        task,
        issueNumber,
        issueMeta,
        startTime,
        cacheKey,
        workerId,
        allocatedSlot,
        opencodeXdg,
        opencodeSessionOptions,
      });
      if (parentVerifyRun) return parentVerifyRun;

      await this.ensureRalphWorkflowLabelsOnce();

      const shouldClearBlocked = Boolean(
        task["blocked-source"]?.trim() || task["blocked-reason"]?.trim() || task["blocked-details"]?.trim()
      );
      const markedStarting = await this.queue.updateTaskStatus(task, "starting", {
        "assigned-at": startTime.toISOString().split("T")[0],
        ...(!task["opencode-profile"]?.trim() && opencodeProfileName ? { "opencode-profile": opencodeProfileName } : {}),
        ...(workerId ? { "worker-id": workerId } : {}),
        ...(typeof allocatedSlot === "number" ? { "repo-slot": String(allocatedSlot) } : {}),
        ...(shouldClearBlocked
          ? {
              "blocked-source": "",
              "blocked-reason": "",
              "blocked-details": "",
              "blocked-at": "",
              "blocked-checked-at": "",
            }
          : {}),
      });
      if (workerId) task["worker-id"] = workerId;
      if (typeof allocatedSlot === "number") task["repo-slot"] = String(allocatedSlot);
      if (!markedStarting) {
        throw new Error("Failed to mark task starting (bwrb edit failed)");
      }

      await this.ensureBranchProtectionOnce();

      const resolvedRepoPath = await this.resolveTaskRepoPath(task, issueNumber, "start", allocatedSlot);
      if (resolvedRepoPath.kind !== "ok") {
        throw new Error(resolvedRepoPath.reason);
      }
      const { repoPath: taskRepoPath, worktreePath } = resolvedRepoPath;
      if (worktreePath) task["worktree-path"] = worktreePath;

      await this.prepareContextRecovery(task, taskRepoPath);

      await this.assertRepoRootClean(task, "start");

      return await this.withRunContext(task, "process", async () => {
        this.publishDashboardEvent(
          {
            type: "worker.created",
            level: "info",
            ...(workerId ? { workerId } : {}),
            repo: this.repo,
            taskId: task._path,
            sessionId: task["session-id"]?.trim() || undefined,
            data: {
              ...(worktreePath ? { worktreePath } : {}),
              ...(typeof allocatedSlot === "number" ? { repoSlot: allocatedSlot } : {}),
            },
          },
          { sessionId: task["session-id"]?.trim() || undefined, workerId }
        );

        this.logWorker(`Starting task: ${task.name}`, { workerId });

        const pausedSetup = await this.pauseIfHardThrottled(task, "setup");
        if (pausedSetup) return pausedSetup;

        const setupRun = await this.ensureSetupForTask({
          task,
          issueNumber,
          taskRepoPath,
          status: "starting",
        });
        if (setupRun) return setupRun;

        const botBranch = getRepoBotBranch(this.repo);
        const mergeConflictRun = await this.maybeHandleQueuedMergeConflict({
          task,
          issueNumber,
          taskRepoPath,
          cacheKey,
          botBranch,
          issueMeta,
          startTime,
          opencodeXdg,
          opencodeSessionOptions,
        });
        if (mergeConflictRun) return mergeConflictRun;

        const ciFailureRun = await this.maybeHandleQueuedCiFailure({
          task,
          issueNumber,
          taskRepoPath,
          cacheKey,
          botBranch,
          issueMeta,
          startTime,
          opencodeXdg,
          opencodeSessionOptions,
        });
        if (ciFailureRun) return ciFailureRun;

        const existingPrForQueue = await this.getIssuePrResolution(issueNumber);
        if (existingPrForQueue.selectedUrl) {
          if (existingPrForQueue.duplicates.length > 0) {
            console.log(
              `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${existingPrForQueue.duplicates.join(", ")}`
            );
          }
          return await this.parkTaskWaitingOnOpenPr(task, issueNumber, existingPrForQueue.selectedUrl);
        }

        const isImplementationTask = isImplementationTaskFromIssue(issueMeta);

        console.log(`[ralph:worker:${this.repo}] Running planner prompt for issue ${issueNumber}`);

        const isTransientCacheENOENT = (output: string) =>
          /ENOENT\s+reading\s+"[^"]*\/opencode\/node_modules\//.test(output) ||
          /ENOENT\s+reading\s+"[^"]*zod\/v4\/locales\//.test(output);

        const pausedPlan = await this.pauseIfHardThrottled(task, "plan");
        if (pausedPlan) return pausedPlan;

        const baseIssueContext = await this.buildIssueContextForAgent({ repo: this.repo, issueNumber });
        let issueContext = baseIssueContext;
        const issueRef = parseIssueRef(task.issue, this.repo);
        if (issueRef) {
          const dossierText = await this.buildChildCompletionDossierText({ issueRef });
          if (dossierText) {
            issueContext = appendChildDossierToIssueContext(baseIssueContext, dossierText);
          }
        }
        const plannerPrompt = buildPlannerPrompt({ repo: this.repo, issueNumber, issueContext });
        const planRunLogPath = await this.recordRunLogPath(task, issueNumber, "plan", "starting");

        let planResult = await this.session.runAgent(taskRepoPath, "ralph-plan", plannerPrompt, {
          repo: this.repo,
          cacheKey,
          runLogPath: planRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 1,
            stepTitle: "plan",
          },
          ...this.buildWatchdogOptions(task, "plan"),
          ...this.buildStallOptions(task, "plan"),
          ...this.buildLoopDetectionOptions(task, "plan"),
          ...opencodeSessionOptions,
        });

        const pausedAfterPlan = await this.pauseIfHardThrottled(task, "plan (post)", planResult.sessionId);
        if (pausedAfterPlan) return pausedAfterPlan;

        if (!planResult.success && planResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
        }

        if (!planResult.success && planResult.stallTimeout) {
          return await this.handleStallTimeout(task, cacheKey, "plan", planResult);
        }

        if (!planResult.success && planResult.loopTrip) {
          return await this.handleLoopTrip(task, cacheKey, "plan", planResult);
        }

        if (!planResult.success && isTransientCacheENOENT(planResult.output)) {
          console.warn(`[ralph:worker:${this.repo}] planner hit transient cache ENOENT; retrying once...`);
          await new Promise((r) => setTimeout(r, 750));
          const planRetryRunLogPath = await this.recordRunLogPath(task, issueNumber, "plan-retry", "starting");

          planResult = await this.session.runAgent(taskRepoPath, "ralph-plan", plannerPrompt, {
            repo: this.repo,
            cacheKey,
            runLogPath: planRetryRunLogPath,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 1,
              stepTitle: "plan (retry)",
            },
            ...this.buildWatchdogOptions(task, "plan-retry"),
            ...this.buildStallOptions(task, "plan-retry"),
            ...this.buildLoopDetectionOptions(task, "plan-retry"),
            ...opencodeSessionOptions,
          });
        }

        const pausedAfterPlanRetry = await this.pauseIfHardThrottled(task, "plan (post retry)", planResult.sessionId);
        if (pausedAfterPlanRetry) return pausedAfterPlanRetry;

        if (!planResult.success) {
          if (planResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
          }

          if (planResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "plan", planResult);
          }

          const classification = classifyOpencodeFailure(planResult.output);
          const reason = classification?.reason ?? `planner failed: ${planResult.output}`;
          const details = planResult.output;

          await this.markTaskBlocked(task, classification?.blockedSource ?? "runtime-error", {
            reason,
            details,
            sessionId: planResult.sessionId,
            runLogPath: planRunLogPath,
          });
          return {
            taskName: task.name,
            repo: this.repo,
            outcome: "failed",
            sessionId: planResult.sessionId,
            escalationReason: reason,
          };
        }

        if (planResult.sessionId) {
          await this.queue.updateTaskStatus(task, "in-progress", {
            "session-id": planResult.sessionId,
            ...(workerId ? { "worker-id": workerId } : {}),
            ...(typeof allocatedSlot === "number" ? { "repo-slot": String(allocatedSlot) } : {}),
          });
        }

        await this.recordCheckpoint(task, "planned", planResult.sessionId);
        this.publishCheckpoint("planned", { sessionId: planResult.sessionId || undefined });

        let routing = parseRoutingDecision(planResult.output);
        let hasGap = hasProductGap(planResult.output);

        await this.recordCheckpoint(task, "routed", planResult.sessionId);

        let devexContext: EscalationContext["devex"] | undefined;
        if (shouldConsultDevex({ routing, hasGap, isImplementationTask })) {
          const baseSessionId = planResult.sessionId;
          console.log(
            `[ralph:worker:${this.repo}] Consulting @devex before escalation (task: ${task.name}, session: ${baseSessionId})`
          );

          const devexPrompt = [
            "You are @devex.",
            "Resolve low-level implementation ambiguity (style, error message patterns, validation scope that does not change public behavior).",
            "IMPORTANT: This runs in a non-interactive daemon. Do NOT ask questions; make reasonable default choices and proceed.",
            "Return a short, actionable summary.",
          ].join("\n");

          const pausedDevexConsult = await this.pauseIfHardThrottled(task, "consult devex", baseSessionId);
          if (pausedDevexConsult) return pausedDevexConsult;

          const devexRunLogPath = await this.recordRunLogPath(task, issueNumber, "consult devex", "in-progress");

          const devexResult = await this.session.continueSession(taskRepoPath, baseSessionId, devexPrompt, {
            agent: "devex",
            repo: this.repo,
            cacheKey,
            runLogPath: devexRunLogPath,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 2,
              stepTitle: "consult devex",
            },
            ...this.buildStallOptions(task, "consult devex"),
            ...this.buildLoopDetectionOptions(task, "consult devex"),
            ...opencodeSessionOptions,
          });

          await this.recordImplementationCheckpoint(task, devexResult.sessionId || baseSessionId);

          const pausedAfterDevexConsult = await this.pauseIfHardThrottled(
            task,
            "consult devex (post)",
            devexResult.sessionId || baseSessionId
          );
          if (pausedAfterDevexConsult) return pausedAfterDevexConsult;

          if (!devexResult.success) {
            if (devexResult.loopTrip) {
              return await this.handleLoopTrip(task, cacheKey, "consult devex", devexResult);
            }
            if (devexResult.stallTimeout) {
              return await this.handleStallTimeout(task, cacheKey, "consult devex", devexResult);
            }
            console.warn(`[ralph:worker:${this.repo}] Devex consult failed: ${devexResult.output}`);
            devexContext = {
              consulted: true,
              sessionId: devexResult.sessionId || baseSessionId,
              summary: `Devex consult failed: ${summarizeForNote(devexResult.output, 400)}`,
            };
          } else {
            const devexSummary = summarizeForNote(devexResult.output);
            devexContext = {
              consulted: true,
              sessionId: devexResult.sessionId || baseSessionId,
              summary: devexSummary,
            };

            console.log(`[ralph:worker:${this.repo}] Devex consulted (task: ${task.name}, session: ${devexContext.sessionId})`);

            const reroutePrompt = [
              "Incorporate the devex guidance below into your plan.",
              "Then output ONLY the routing decision JSON code block.",
              "Do not ask questions.",
              "If an open question touches a user-facing contract surface (e.g. CLI flags/args, exit codes, stdout/stderr formats, config schema, machine-readable outputs), set decision=escalate (policy: docs/escalation-policy.md).",
              "",
              "Devex guidance:",
              devexSummary || devexResult.output,
            ].join("\n");

            const pausedReroute = await this.pauseIfHardThrottled(task, "reroute after devex", baseSessionId);
            if (pausedReroute) return pausedReroute;

            const rerouteRunLogPath = await this.recordRunLogPath(task, issueNumber, "reroute after devex", "in-progress");

            const rerouteResult = await this.session.continueSession(taskRepoPath, baseSessionId, reroutePrompt, {
              repo: this.repo,
              cacheKey,
              runLogPath: rerouteRunLogPath,
              introspection: {
                repo: this.repo,
                issue: task.issue,
                taskName: task.name,
                step: 3,
                stepTitle: "reroute after devex",
              },
              ...this.buildStallOptions(task, "reroute after devex"),
              ...this.buildLoopDetectionOptions(task, "reroute after devex"),
              ...opencodeSessionOptions,
            });

            await this.recordImplementationCheckpoint(task, rerouteResult.sessionId || baseSessionId);

            const pausedAfterReroute = await this.pauseIfHardThrottled(
              task,
              "reroute after devex (post)",
              rerouteResult.sessionId || baseSessionId
            );
            if (pausedAfterReroute) return pausedAfterReroute;

            if (!rerouteResult.success) {
              if (rerouteResult.loopTrip) {
                return await this.handleLoopTrip(task, cacheKey, "reroute after devex", rerouteResult);
              }
              if (rerouteResult.stallTimeout) {
                return await this.handleStallTimeout(task, cacheKey, "reroute after devex", rerouteResult);
              }
              console.warn(`[ralph:worker:${this.repo}] Reroute after devex consult failed: ${rerouteResult.output}`);
            } else {
              if (rerouteResult.sessionId) {
                await this.queue.updateTaskStatus(task, "in-progress", { "session-id": rerouteResult.sessionId });
              }

              const updatedRouting = parseRoutingDecision(rerouteResult.output);
              if (updatedRouting) routing = updatedRouting;

              hasGap = hasGap || hasProductGap(rerouteResult.output);
            }
          }
        }

        this.publishCheckpoint("routed", { sessionId: planResult.sessionId || undefined });
        const shouldEscalate = this.shouldEscalate(routing, hasGap, isImplementationTask);

        if (shouldEscalate) {
          const reason =
            routing?.escalation_reason ||
            (hasGap
              ? "Product documentation gap identified"
              : routing?.decision === "escalate" && routing?.confidence === "high"
                ? "High-confidence escalation requested"
                : "Escalation requested");

          let escalationType: EscalationContext["escalationType"] = "other";
          if (hasGap) {
            escalationType = "product-gap";
          } else if (isExplicitBlockerReason(routing?.escalation_reason)) {
            escalationType = "blocked";
          } else if (routing?.escalation_reason?.toLowerCase().includes("ambiguous")) {
            escalationType = "ambiguous-requirements";
          }

          console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

          const wasEscalated = task.status === "escalated";
          const escalated = await this.queue.updateTaskStatus(task, "escalated");
          if (escalated) {
            applyTaskPatch(task, "escalated", {});
          }
          await this.writeEscalationWriteback(task, { reason, escalationType });
          await this.notify.notifyEscalation({
            taskName: task.name,
            taskFileName: task._name,
            taskPath: task._path,
            issue: task.issue,
            repo: this.repo,
            sessionId: planResult.sessionId,
            reason,
            escalationType,
            planOutput: planResult.output,
            routing: routing
              ? {
                  decision: routing.decision,
                  confidence: routing.confidence,
                  escalation_reason: routing.escalation_reason ?? undefined,
                  plan_summary: routing.plan_summary ?? undefined,
                }
              : undefined,
            devex: devexContext,
          });

          if (escalated && !wasEscalated) {
            await this.recordEscalatedRunNote(task, {
              reason,
              sessionId: planResult.sessionId,
              details: planResult.output,
            });
          }

          return {
            taskName: task.name,
            repo: this.repo,
            outcome: "escalated",
            sessionId: planResult.sessionId,
            escalationReason: reason,
          };
        }

        console.log(`[ralph:worker:${this.repo}] Proceeding with build...`);
        const existingPr = await this.getIssuePrResolution(issueNumber);
        const proceedMessage = existingPr.selectedUrl
          ? [
              `An open PR already exists for this issue: ${existingPr.selectedUrl}.`,
              "Do NOT create a new PR.",
              "Fix any failing checks and push updates to the existing PR branch.",
              "Only paste a PR URL if it changes.",
            ].join(" ")
          : `Proceed with implementation. Target your PR to the \`${botBranch}\` branch.`;

        if (existingPr.selectedUrl) {
          console.log(
            `[ralph:worker:${this.repo}] Reusing existing PR for build: ${existingPr.selectedUrl} (source=${
              existingPr.source ?? "unknown"
            })`
          );
          await this.markIssueInProgressForOpenPrBestEffort(task, existingPr.selectedUrl);
          if (existingPr.duplicates.length > 0) {
            console.log(`[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${existingPr.duplicates.join(", ")}`);
          }
        }

        const pausedBuild = await this.pauseIfHardThrottled(task, "build", planResult.sessionId);
        if (pausedBuild) return pausedBuild;

        const buildRunLogPath = await this.recordRunLogPath(task, issueNumber, "build", "in-progress");

        let buildResult = await this.session.continueSession(taskRepoPath, planResult.sessionId, proceedMessage, {
          repo: this.repo,
          cacheKey,
          runLogPath: buildRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "build",
          },
          ...this.buildWatchdogOptions(task, "build"),
          ...this.buildStallOptions(task, "build"),
          ...this.buildLoopDetectionOptions(task, "build"),
          ...opencodeSessionOptions,
        });

        await this.recordImplementationCheckpoint(task, buildResult.sessionId || planResult.sessionId);

        const pausedAfterBuild = await this.pauseIfHardThrottled(task, "build (post)", buildResult.sessionId || planResult.sessionId);
        if (pausedAfterBuild) return pausedAfterBuild;

        if (!buildResult.success) {
          if (buildResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "build", buildResult);
          }
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "build", buildResult, opencodeXdg);
          }

          if (buildResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "build", buildResult);
          }
          throw new Error(`Build failed: ${buildResult.output}`);
        }

        this.publishCheckpoint("implementation_step_complete", {
          sessionId: buildResult.sessionId || planResult.sessionId || undefined,
        });

        if (buildResult.sessionId) {
          await this.queue.updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
        }

        await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build", opencodeXdg);

        const MAX_CONTINUE_RETRIES = 5;
        let prUrl = this.updateOpenPrSnapshot(
          task,
          null,
          selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
        );
        let prRecoveryDiagnostics = "";

        if (!prUrl) {
          const recovered = await this.tryEnsurePrFromWorktree({
            task,
            issueNumber,
            issueTitle: issueMeta.title || task.name,
            botBranch,
          });
          prRecoveryDiagnostics = recovered.diagnostics;
          prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
        }

        let continueAttempts = 0;
        let anomalyAborts = 0;
        let lastAnomalyCount = 0;
        let prCreateLeaseKey: string | null = null;

        while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
          await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build", opencodeXdg);

          const anomalyStatus = await readLiveAnomalyCount(buildResult.sessionId);
          const newAnomalies = anomalyStatus.total - lastAnomalyCount;
          lastAnomalyCount = anomalyStatus.total;

          if (anomalyStatus.total >= ANOMALY_BURST_THRESHOLD || anomalyStatus.recentBurst) {
            anomalyAborts++;
            console.warn(
              `[ralph:worker:${this.repo}] Anomaly burst detected (${anomalyStatus.total} total, ${newAnomalies} new). ` +
                `Abort #${anomalyAborts}/${MAX_ANOMALY_ABORTS}`
            );

            if (anomalyAborts >= MAX_ANOMALY_ABORTS) {
              const reason = `Agent stuck in tool-result-as-text loop (${anomalyStatus.total} anomalies detected, aborted ${anomalyAborts} times)`;
              console.log(`[ralph:worker:${this.repo}] Escalating due to repeated anomaly loops`);

              const wasEscalated = task.status === "escalated";
              const escalated = await this.queue.updateTaskStatus(task, "escalated");
              if (escalated) {
                applyTaskPatch(task, "escalated", {});
              }
              await this.writeEscalationWriteback(task, { reason, escalationType: "other" });
              await this.notify.notifyEscalation({
                taskName: task.name,
                taskFileName: task._name,
                taskPath: task._path,
                issue: task.issue,
                repo: this.repo,
                sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
                reason,
                escalationType: "other",
                planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
              });

              if (escalated && !wasEscalated) {
                await this.recordEscalatedRunNote(task, {
                  reason,
                  sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
                  details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
                });
              }

              return {
                taskName: task.name,
                repo: this.repo,
                outcome: "escalated",
                sessionId: buildResult.sessionId,
                escalationReason: reason,
              };
            }

            console.log(`[ralph:worker:${this.repo}] Sending loop-break nudge...`);

            const pausedBuildLoopBreak = await this.pauseIfHardThrottled(task, "build loop-break", buildResult.sessionId);
            if (pausedBuildLoopBreak) return pausedBuildLoopBreak;

            const buildLoopBreakRunLogPath = await this.recordRunLogPath(task, issueNumber, "build loop-break", "in-progress");

            buildResult = await this.session.continueSession(
              taskRepoPath,
              buildResult.sessionId,
              "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
              {
                repo: this.repo,
                cacheKey,
                runLogPath: buildLoopBreakRunLogPath,
                introspection: {
                  repo: this.repo,
                  issue: task.issue,
                  taskName: task.name,
                  step: 4,
                  stepTitle: "build loop-break",
                },
                ...this.buildWatchdogOptions(task, "build-loop-break"),
                ...this.buildStallOptions(task, "build-loop-break"),
                ...this.buildLoopDetectionOptions(task, "build-loop-break"),
                ...opencodeSessionOptions,
              }
            );

            await this.recordImplementationCheckpoint(task, buildResult.sessionId);

            const pausedBuildLoopBreakAfter = await this.pauseIfHardThrottled(task, "build loop-break (post)", buildResult.sessionId);
            if (pausedBuildLoopBreakAfter) return pausedBuildLoopBreakAfter;

            if (!buildResult.success) {
              if (buildResult.loopTrip) {
                return await this.handleLoopTrip(task, cacheKey, "build-loop-break", buildResult);
              }
              if (buildResult.watchdogTimeout) {
                return await this.handleWatchdogTimeout(task, cacheKey, "build-loop-break", buildResult, opencodeXdg);
              }

              if (buildResult.stallTimeout) {
                return await this.handleStallTimeout(task, cacheKey, "build-loop-break", buildResult);
              }
              console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
              break;
            }

            this.publishCheckpoint("implementation_step_complete", {
              sessionId: buildResult.sessionId || planResult.sessionId || undefined,
            });

            lastAnomalyCount = anomalyStatus.total;
            prUrl = this.updateOpenPrSnapshot(
              task,
              prUrl,
              selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
            );
            continue;
          }

          const canonical = await this.getIssuePrResolution(issueNumber);
          if (canonical.selectedUrl) {
            console.log(
              `[ralph:worker:${this.repo}] Reusing existing PR during build: ${canonical.selectedUrl} (source=${
                canonical.source ?? "unknown"
              })`
            );
            await this.markIssueInProgressForOpenPrBestEffort(task, canonical.selectedUrl);
            if (canonical.duplicates.length > 0) {
              console.log(`[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`);
            }
            prRecoveryDiagnostics = [prRecoveryDiagnostics, canonical.diagnostics.join("\n")].filter(Boolean).join("\n\n");
            prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
            break;
          }

          if (!prCreateLeaseKey) {
            const lease = this.tryClaimPrCreateLease({
              task,
              issueNumber,
              botBranch,
              sessionId: buildResult.sessionId,
              stage: "build",
            });

            if (!lease.claimed) {
              console.warn(
                `[ralph:worker:${this.repo}] PR-create lease already held; waiting instead of creating duplicate (lease=${lease.key})`
              );

              const waited = await this.waitForExistingPrDuringPrCreateConflict({
                issueNumber,
                maxWaitMs: PR_CREATE_CONFLICT_WAIT_MS,
              });

              if (waited?.selectedUrl) {
                await this.markIssueInProgressForOpenPrBestEffort(task, waited.selectedUrl);
                prRecoveryDiagnostics = [prRecoveryDiagnostics, waited.diagnostics.join("\n")].filter(Boolean).join("\n\n");
                prUrl = this.updateOpenPrSnapshot(task, prUrl, waited.selectedUrl);
                break;
              }

              const throttled = await this.throttleForPrCreateConflict({
                task,
                issueNumber,
                sessionId: buildResult.sessionId,
                leaseKey: lease.key,
                existingCreatedAt: lease.existingCreatedAt,
                stage: "build",
              });
              if (throttled) return throttled;

              prRecoveryDiagnostics = [
                prRecoveryDiagnostics,
                `PR-create conflict: lease=${lease.key} (createdAt=${lease.existingCreatedAt ?? "unknown"})`,
              ]
                .filter(Boolean)
                .join("\n\n");
              break;
            }

            prCreateLeaseKey = lease.key;
            console.log(`[ralph:worker:${this.repo}] pr_mode=create lease=${lease.key}`);
          }

          continueAttempts++;
          console.log(
            `[ralph:worker:${this.repo}] No PR URL found; requesting PR creation (attempt ${continueAttempts}/${MAX_CONTINUE_RETRIES})`
          );

          const pausedBuildContinue = await this.pauseIfHardThrottled(task, "build continue", buildResult.sessionId);
          if (pausedBuildContinue) return pausedBuildContinue;

          const nudge = this.buildPrCreationNudge(botBranch, issueNumber, task.issue);
          const buildContinueRunLogPath = await this.recordRunLogPath(task, issueNumber, "build continue", "in-progress");

          buildResult = await this.session.continueSession(taskRepoPath, buildResult.sessionId, nudge, {
            repo: this.repo,
            cacheKey,
            runLogPath: buildContinueRunLogPath,
            timeoutMs: 10 * 60_000,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 4,
              stepTitle: "build continue",
            },
            ...this.buildWatchdogOptions(task, "build-continue"),
            ...this.buildStallOptions(task, "build-continue"),
            ...this.buildLoopDetectionOptions(task, "build-continue"),
            ...opencodeSessionOptions,
          });

          await this.recordImplementationCheckpoint(task, buildResult.sessionId);

          const pausedBuildContinueAfter = await this.pauseIfHardThrottled(task, "build continue (post)", buildResult.sessionId);
          if (pausedBuildContinueAfter) return pausedBuildContinueAfter;

          if (!buildResult.success) {
            if (buildResult.loopTrip) {
              return await this.handleLoopTrip(task, cacheKey, "build-continue", buildResult);
            }
            if (buildResult.watchdogTimeout) {
              return await this.handleWatchdogTimeout(task, cacheKey, "build-continue", buildResult, opencodeXdg);
            }

            if (buildResult.stallTimeout) {
              return await this.handleStallTimeout(task, cacheKey, "build-continue", buildResult);
            }

            const recovered = await this.tryEnsurePrFromWorktree({
              task,
              issueNumber,
              issueTitle: issueMeta.title || task.name,
              botBranch,
            });
            prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
            prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);

            if (!prUrl) {
              console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
              break;
            }
          } else {
            this.publishCheckpoint("implementation_step_complete", {
              sessionId: buildResult.sessionId || planResult.sessionId || undefined,
            });
            prUrl = this.updateOpenPrSnapshot(
              task,
              prUrl,
              selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
            );
          }
        }

        if (!prUrl) {
          const recovered = await this.tryEnsurePrFromWorktree({
            task,
            issueNumber,
            issueTitle: issueMeta.title || task.name,
            botBranch,
          });
          prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
        }

        if (!prUrl) {
          const reason = `Agent completed but did not create a PR after ${continueAttempts} continue attempts`;
          console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

          const wasEscalated = task.status === "escalated";
          const escalated = await this.queue.updateTaskStatus(task, "escalated");
          if (escalated) {
            applyTaskPatch(task, "escalated", {});
          }
          await this.writeEscalationWriteback(task, { reason, escalationType: "other" });
          await this.notify.notifyEscalation({
            taskName: task.name,
            taskFileName: task._name,
            taskPath: task._path,
            issue: task.issue,
            repo: this.repo,
            sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
            reason,
            escalationType: "other",
            planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
          });

          if (escalated && !wasEscalated) {
            await this.recordEscalatedRunNote(task, {
              reason,
              sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
              details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
            });
          }

          return {
            taskName: task.name,
            repo: this.repo,
            outcome: "escalated",
            sessionId: buildResult.sessionId,
            escalationReason: reason,
          };
        }

        if (prUrl && prCreateLeaseKey) {
          try {
            deleteIdempotencyKey(prCreateLeaseKey);
          } catch {
          }
          prCreateLeaseKey = null;
        }

        const canonical = await this.getIssuePrResolution(issueNumber);
        if (canonical.selectedUrl && !this.isSamePrUrl(prUrl, canonical.selectedUrl)) {
          console.log(
            `[ralph:worker:${this.repo}] Detected duplicate PR; using existing ${canonical.selectedUrl} instead of ${prUrl}`
          );
          if (canonical.duplicates.length > 0) {
            console.log(`[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`);
          }
          prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
        }

        this.publishCheckpoint("pr_ready", { sessionId: buildResult.sessionId || planResult.sessionId || undefined });

        const pausedMerge = await this.pauseIfHardThrottled(task, "merge", buildResult.sessionId);
        if (pausedMerge) return pausedMerge;

        const mergeGate = await this.mergePrWithRequiredChecks({
          task,
          repoPath: taskRepoPath,
          cacheKey,
          botBranch,
          prUrl,
          sessionId: buildResult.sessionId,
          issueMeta,
          watchdogStagePrefix: "merge",
          notifyTitle: `Merging ${task.name}`,
          opencodeXdg,
        });

        if (!mergeGate.ok) return mergeGate.run;

        const pausedMergeAfter = await this.pauseIfHardThrottled(task, "merge (post)", mergeGate.sessionId || buildResult.sessionId);
        if (pausedMergeAfter) return pausedMergeAfter;

        this.publishCheckpoint("merge_step_complete", {
          sessionId: mergeGate.sessionId || buildResult.sessionId || planResult.sessionId || undefined,
        });

        prUrl = mergeGate.prUrl;
        buildResult.sessionId = mergeGate.sessionId;

        console.log(`[ralph:worker:${this.repo}] Running survey...`);
        const pausedSurvey = await this.pauseIfHardThrottled(task, "survey", buildResult.sessionId);
        if (pausedSurvey) return pausedSurvey;

        const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
        const surveyRunLogPath = await this.recordRunLogPath(task, issueNumber, "survey", "in-progress");

        const surveyResult = await this.session.continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
          repo: this.repo,
          cacheKey,
          runLogPath: surveyRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 6,
            stepTitle: "survey",
          },
          ...this.buildWatchdogOptions(task, "survey"),
          ...this.buildStallOptions(task, "survey"),
          ...this.buildLoopDetectionOptions(task, "survey"),
          ...opencodeSessionOptions,
        });

        await this.recordImplementationCheckpoint(task, surveyResult.sessionId || buildResult.sessionId);

        const pausedSurveyAfter = await this.pauseIfHardThrottled(task, "survey (post)", surveyResult.sessionId || buildResult.sessionId);
        if (pausedSurveyAfter) return pausedSurveyAfter;

        if (!surveyResult.success) {
          if (surveyResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "survey", surveyResult);
          }
          if (surveyResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
          }

          if (surveyResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "survey", surveyResult);
          }
          console.warn(`[ralph:worker:${this.repo}] Survey may have failed: ${surveyResult.output}`);
        }

        try {
          await writeDxSurveyToGitHubIssues({
            github: this.github,
            targetRepo: this.repo,
            ralphRepo: "3mdistal/ralph",
            issueNumber,
            taskName: task.name,
            cacheKey,
            prUrl: prUrl ?? null,
            sessionId: surveyResult.sessionId || buildResult.sessionId || null,
            surveyOutput: surveyResult.output,
          });
        } catch (error: any) {
          console.warn(`[ralph:worker:${this.repo}] Failed to file DX survey issues: ${error?.message ?? String(error)}`);
        }

        await this.recordCheckpoint(task, "survey_complete", surveyResult.sessionId || buildResult.sessionId);
        this.publishCheckpoint("survey_complete", {
          sessionId: surveyResult.sessionId || buildResult.sessionId || planResult.sessionId || undefined,
        });

        return await this.finalizeTaskSuccess({
          task,
          prUrl,
          sessionId: buildResult.sessionId,
          startTime,
          surveyResults: surveyResult.output,
          cacheKey,
          opencodeXdg,
          worktreePath,
          workerId,
          repoSlot: typeof allocatedSlot === "number" ? String(allocatedSlot) : undefined,
          devex: devexContext,
          notify: true,
          logMessage: `Task completed: ${task.name}`,
        });
      });
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Task failed:`, error);

      if (!error?.ralphRootDirty) {
        const paused = await this.pauseIfGitHubRateLimited(task, "process", error, {
          sessionId: task["session-id"]?.trim() || undefined,
          runLogPath: task["run-log-path"]?.trim() || undefined,
        });
        if (paused) return paused;

        const reason = error?.message ?? String(error);
        const details = error?.stack ?? reason;
        const classification = classifyOpencodeFailure(`${reason}\n${details}`);
        await this.markTaskBlocked(task, classification?.blockedSource ?? "runtime-error", {
          reason: classification?.reason ?? reason,
          details,
        });
      }

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
    }
  }).call(deps);
}
