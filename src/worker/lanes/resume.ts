import { existsSync } from "fs";

import { getRepoBotBranch } from "../../config";
import { isRepoAllowed } from "../../github-app-auth";
import { classifyOpencodeFailure } from "../../opencode-error-classifier";
import { selectPrUrl } from "../../routing";
import { deleteIdempotencyKey } from "../../state";
import { writeDxSurveyToGitHubIssues } from "../../github/dx-survey-writeback";
import type { AgentTask } from "../../queue-backend";
import { applyTaskPatch } from "../task-patch";
import { readLiveAnomalyCount } from "../introspection";
import type { AgentRun } from "../repo-worker";
import { derivePrCreateEscalationReason } from "../pr-create-escalation-reason";

type ResumeTaskOptions = { resumeMessage?: string; repoSlot?: number | null };

export type ResumeLaneDeps = any;

const ANOMALY_BURST_THRESHOLD = 50;
const MAX_ANOMALY_ABORTS = 3;
const PR_CREATE_CONFLICT_WAIT_MS = 2 * 60_000;

export async function runResumeLane(deps: ResumeLaneDeps, task: AgentTask, opts?: ResumeTaskOptions): Promise<AgentRun> {
  return await (async function (this: ResumeLaneDeps): Promise<AgentRun> {
    const startTime = new Date();

    if (!isRepoAllowed(task.repo)) {
      return await this.blockDisallowedRepo(task, startTime, "resume");
    }

    const issueMeta = await this.getIssueMetadata(task.issue);
    if (issueMeta.state === "CLOSED") {
      return await this.skipClosedIssue(task, issueMeta, startTime);
    }

    await this.ensureRalphWorkflowLabelsOnce();
    await this.ensureBranchProtectionOnce();

    const issueMatch = task.issue.match(/#(\d+)$/);
    const issueNumber = issueMatch?.[1] ?? "";
    const cacheKey = issueNumber || task._name;

    const existingSessionId = task["session-id"]?.trim();
    if (!existingSessionId) {
      const reason = "In-progress task has no session-id; cannot resume";
      console.warn(`[ralph:worker:${this.repo}] ${reason}: ${task.name}`);
      await this.queue.updateTaskStatus(task, "starting", { "session-id": "" });
      return { taskName: task.name, repo: this.repo, outcome: "failed", escalationReason: reason };
    }

    const workerId = await this.formatWorkerId(task, task._path);
    const allocatedSlot = this.resolveAssignedRepoSlot(task, opts?.repoSlot);

    try {
      await this.assertRepoRootClean(task, "resume");

      const resolvedRepoPath = await this.resolveTaskRepoPath(task, issueNumber || cacheKey, "resume", allocatedSlot);

      if (resolvedRepoPath.kind === "reset") {
        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: existingSessionId,
          escalationReason: resolvedRepoPath.reason,
        };
      }

      const { repoPath: taskRepoPath, worktreePath } = resolvedRepoPath;
      if (worktreePath) task["worktree-path"] = worktreePath;

      await this.prepareContextRecovery(task, taskRepoPath);

      const workerIdChanged = task["worker-id"]?.trim() !== workerId;
      const repoSlotChanged = task["repo-slot"]?.trim() !== String(allocatedSlot);

      if (workerIdChanged || repoSlotChanged) {
        await this.queue.updateTaskStatus(task, "in-progress", {
          ...(workerIdChanged ? { "worker-id": workerId } : {}),
          ...(repoSlotChanged ? { "repo-slot": String(allocatedSlot) } : {}),
        });
        task["worker-id"] = workerId;
        task["repo-slot"] = String(allocatedSlot);
      }

      const eventWorkerId = task["worker-id"]?.trim();

      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "resume", existingSessionId);

      if (resolvedOpencode.error) throw new Error(resolvedOpencode.error);

      const opencodeProfileName = resolvedOpencode.profileName;
      const opencodeXdg = resolvedOpencode.opencodeXdg;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      if (!task["opencode-profile"]?.trim() && opencodeProfileName) {
        await this.queue.updateTaskStatus(task, "in-progress", { "opencode-profile": opencodeProfileName });
      }

      const pausedSetup = await this.pauseIfHardThrottled(task, "setup (resume)", existingSessionId);
      if (pausedSetup) return pausedSetup;

      const setupRun = await this.ensureSetupForTask({
        task,
        issueNumber: issueNumber || cacheKey,
        taskRepoPath,
        status: "in-progress",
        sessionId: existingSessionId,
      });
      if (setupRun) return setupRun;

      const botBranch = getRepoBotBranch(this.repo);
      const mergeConflictRun = await this.maybeHandleQueuedMergeConflict({
        task,
        issueNumber: issueNumber || cacheKey,
        taskRepoPath,
        cacheKey,
        botBranch,
        issueMeta,
        startTime,
        opencodeXdg,
        opencodeSessionOptions,
      });
      if (mergeConflictRun) return mergeConflictRun;

      const defaultResumeMessage =
        "Ralph restarted while this task was in progress. " +
        "Resume from where you left off. " +
        "If you already created a PR, paste the PR URL. " +
        `Otherwise continue implementing and create a PR targeting the '${botBranch}' branch.`;

      const resumeMessage = opts?.resumeMessage?.trim();
      const baseResumeMessage = resumeMessage || defaultResumeMessage;
      const existingPr = await this.getIssuePrResolution(issueNumber);
      const finalResumeMessage = existingPr.selectedUrl
        ? [
            `An open PR already exists for this issue: ${existingPr.selectedUrl}.`,
            "Do NOT create a new PR.",
            "Continue work on the existing PR branch and push updates as needed.",
            resumeMessage ?? "",
            "Only paste a PR URL if it changes.",
          ]
            .filter(Boolean)
            .join(" ")
        : baseResumeMessage;

      if (existingPr.selectedUrl) {
        console.log(
          `[ralph:worker:${this.repo}] Reusing existing PR for resume: ${existingPr.selectedUrl} (source=${
            existingPr.source ?? "unknown"
          })`
        );
        await this.markIssueInProgressForOpenPrBestEffort(task, existingPr.selectedUrl);
        if (existingPr.duplicates.length > 0) {
          console.log(
            `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${existingPr.duplicates.join(", ")}`
          );
        }
      }

      const pausedBefore = await this.pauseIfHardThrottled(task, "resume", existingSessionId);
      if (pausedBefore) return pausedBefore;

      return await this.withRunContext(task, "resume", async () => {
        this.publishDashboardEvent(
          {
            type: "worker.created",
            level: "info",
            ...(eventWorkerId ? { workerId: eventWorkerId } : {}),
            repo: this.repo,
            taskId: task._path,
            sessionId: existingSessionId,
            data: {
              ...(worktreePath ? { worktreePath } : {}),
              ...(typeof allocatedSlot === "number" ? { repoSlot: allocatedSlot } : {}),
            },
          },
          { sessionId: existingSessionId, workerId: eventWorkerId }
        );

        this.logWorker(`Resuming task: ${task.name}`, { sessionId: existingSessionId, workerId: eventWorkerId });

        const resumeRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "resume", "in-progress");

        let buildResult = await this.session.continueSession(taskRepoPath, existingSessionId, finalResumeMessage, {
          repo: this.repo,
          cacheKey,
          runLogPath: resumeRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "resume",
          },
          ...this.buildWatchdogOptions(task, "resume"),
          ...this.buildStallOptions(task, "resume"),
          ...this.buildLoopDetectionOptions(task, "resume"),
          ...opencodeSessionOptions,
        });

        await this.recordImplementationCheckpoint(task, buildResult.sessionId || existingSessionId);

        const pausedAfter = await this.pauseIfHardThrottled(task, "resume (post)", buildResult.sessionId || existingSessionId);
        if (pausedAfter) return pausedAfter;

        if (!buildResult.success) {
          if (buildResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "resume", buildResult);
          }
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "resume", buildResult, opencodeXdg);
          }

          if (buildResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "resume", buildResult);
          }

          const reason = `Failed to resume OpenCode session ${existingSessionId}: ${buildResult.output}`;
          console.warn(`[ralph:worker:${this.repo}] Resume failed; falling back to fresh run: ${reason}`);

          await this.queue.updateTaskStatus(task, "queued", { "session-id": "" });

          return {
            taskName: task.name,
            repo: this.repo,
            outcome: "failed",
            sessionId: existingSessionId,
            escalationReason: reason,
          };
        }

        this.publishCheckpoint("implementation_step_complete", {
          sessionId: buildResult.sessionId || existingSessionId || undefined,
        });

        if (buildResult.sessionId) {
          await this.queue.updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
        }

        await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume", opencodeXdg);

        const MAX_CONTINUE_RETRIES = 5;
        let prUrl = this.updateOpenPrSnapshot(
          task,
          null,
          selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
        );
        let prRecoveryDiagnostics = "";

        const prCreateEvidence: string[] = [];
        const addPrCreateEvidence = (output: unknown): void => {
          const normalized = String(output ?? "").trim();
          if (normalized) prCreateEvidence.push(normalized);
        };
        addPrCreateEvidence(buildResult.output);

        if (!prUrl) {
          const recovered = await this.tryEnsurePrFromWorktree({
            task,
            issueNumber,
            issueTitle: issueMeta.title || task.name,
            botBranch,
            started: startTime,
          });
          if (recovered.terminalRun) return recovered.terminalRun;
          prRecoveryDiagnostics = recovered.diagnostics;
          prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
        }

        let continueAttempts = 0;
        let anomalyAborts = 0;
        let lastAnomalyCount = 0;
        let prCreateLeaseKey: string | null = null;

        while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
          await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume", opencodeXdg);

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
              await this.writeEscalationWriteback(task, {
                reason,
                details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
                escalationType: "other",
              });
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

            const pausedLoopBreak = await this.pauseIfHardThrottled(task, "resume loop-break", buildResult.sessionId || existingSessionId);
            if (pausedLoopBreak) return pausedLoopBreak;

            const loopBreakRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "resume loop-break", "in-progress");

            buildResult = await this.session.continueSession(
              taskRepoPath,
              buildResult.sessionId,
              "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
              {
                repo: this.repo,
                cacheKey,
                runLogPath: loopBreakRunLogPath,
                introspection: {
                  repo: this.repo,
                  issue: task.issue,
                  taskName: task.name,
                  step: 4,
                  stepTitle: "resume loop-break",
                },
                ...this.buildWatchdogOptions(task, "resume-loop-break"),
                ...this.buildStallOptions(task, "resume-loop-break"),
                ...this.buildLoopDetectionOptions(task, "resume-loop-break"),
                ...opencodeSessionOptions,
              }
            );

            await this.recordImplementationCheckpoint(task, buildResult.sessionId || existingSessionId);

            const pausedLoopBreakAfter = await this.pauseIfHardThrottled(
              task,
              "resume loop-break (post)",
              buildResult.sessionId || existingSessionId
            );
            if (pausedLoopBreakAfter) return pausedLoopBreakAfter;

            if (!buildResult.success) {
              if (buildResult.loopTrip) {
                return await this.handleLoopTrip(task, cacheKey, "resume-loop-break", buildResult);
              }
              if (buildResult.watchdogTimeout) {
                return await this.handleWatchdogTimeout(task, cacheKey, "resume-loop-break", buildResult, opencodeXdg);
              }

              if (buildResult.stallTimeout) {
                return await this.handleStallTimeout(task, cacheKey, "resume-loop-break", buildResult);
              }
              console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
              break;
            }

            this.publishCheckpoint("implementation_step_complete", {
              sessionId: buildResult.sessionId || existingSessionId || undefined,
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
              `[ralph:worker:${this.repo}] Reusing existing PR during resume: ${canonical.selectedUrl} (source=${
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
              stage: "resume",
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
                stage: "resume",
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

          const pausedContinue = await this.pauseIfHardThrottled(task, "resume continue", buildResult.sessionId || existingSessionId);
          if (pausedContinue) return pausedContinue;

          const nudge = this.buildPrCreationNudge(botBranch, issueNumber, task.issue);
          const resumeContinueRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "continue", "in-progress");

          buildResult = await this.session.continueSession(taskRepoPath, buildResult.sessionId, nudge, {
            repo: this.repo,
            cacheKey,
            runLogPath: resumeContinueRunLogPath,
            timeoutMs: 10 * 60_000,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 4,
              stepTitle: "continue",
            },
            ...this.buildWatchdogOptions(task, "resume-continue"),
            ...this.buildStallOptions(task, "resume-continue"),
            ...this.buildLoopDetectionOptions(task, "resume-continue"),
            ...opencodeSessionOptions,
          });

          addPrCreateEvidence(buildResult.output);

          await this.recordImplementationCheckpoint(task, buildResult.sessionId || existingSessionId);

          const pausedContinueAfter = await this.pauseIfHardThrottled(
            task,
            "resume continue (post)",
            buildResult.sessionId || existingSessionId
          );
          if (pausedContinueAfter) return pausedContinueAfter;

          if (!buildResult.success) {
            if (buildResult.loopTrip) {
              return await this.handleLoopTrip(task, cacheKey, "resume-continue", buildResult);
            }
            if (buildResult.watchdogTimeout) {
              return await this.handleWatchdogTimeout(task, cacheKey, "resume-continue", buildResult, opencodeXdg);
            }

            if (buildResult.stallTimeout) {
              return await this.handleStallTimeout(task, cacheKey, "resume-continue", buildResult);
            }

            const recovered = await this.tryEnsurePrFromWorktree({
              task,
              issueNumber,
              issueTitle: issueMeta.title || task.name,
              botBranch,
              started: startTime,
            });
            if (recovered.terminalRun) return recovered.terminalRun;
            prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
            prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);

            if (!prUrl) {
              console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
              break;
            }
          } else {
            this.publishCheckpoint("implementation_step_complete", {
              sessionId: buildResult.sessionId || existingSessionId || undefined,
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
            started: startTime,
          });
          if (recovered.terminalRun) return recovered.terminalRun;
          prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
        }

        if (!prUrl) {
          const derived = derivePrCreateEscalationReason({ continueAttempts, evidence: prCreateEvidence });
          const reason = derived.reason;
          console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

          const wasEscalated = task.status === "escalated";
          const escalated = await this.queue.updateTaskStatus(task, "escalated");
          if (escalated) {
            applyTaskPatch(task, "escalated", {});
          }
          await this.writeEscalationWriteback(task, {
            reason,
            details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
            escalationType: "other",
          });
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

        this.publishCheckpoint("pr_ready", { sessionId: buildResult.sessionId || existingSessionId || undefined });

        const pausedMerge = await this.pauseIfHardThrottled(task, "resume merge", buildResult.sessionId || existingSessionId);
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

        const pausedMergeAfter = await this.pauseIfHardThrottled(
          task,
          "resume merge (post)",
          mergeGate.sessionId || buildResult.sessionId || existingSessionId
        );
        if (pausedMergeAfter) return pausedMergeAfter;

        this.publishCheckpoint("merge_step_complete", {
          sessionId: mergeGate.sessionId || buildResult.sessionId || existingSessionId || undefined,
        });

        prUrl = mergeGate.prUrl;
        buildResult.sessionId = mergeGate.sessionId;

        console.log(`[ralph:worker:${this.repo}] Running survey...`);
        const pausedSurvey = await this.pauseIfHardThrottled(task, "resume survey", buildResult.sessionId || existingSessionId);
        if (pausedSurvey) return pausedSurvey;

        const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
        const resumeSurveyRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "survey", "in-progress");

        const surveyResult = await this.session.continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
          repo: this.repo,
          cacheKey,
          runLogPath: resumeSurveyRunLogPath,
          ...this.buildWatchdogOptions(task, "resume-survey"),
          ...this.buildStallOptions(task, "resume-survey"),
          ...this.buildLoopDetectionOptions(task, "resume-survey"),
          ...opencodeSessionOptions,
        });

        await this.recordImplementationCheckpoint(task, surveyResult.sessionId || buildResult.sessionId || existingSessionId);

        const pausedSurveyAfter = await this.pauseIfHardThrottled(
          task,
          "resume survey (post)",
          surveyResult.sessionId || buildResult.sessionId || existingSessionId
        );
        if (pausedSurveyAfter) return pausedSurveyAfter;

        if (!surveyResult.success) {
          if (surveyResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "resume-survey", surveyResult);
          }
          if (surveyResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "resume-survey", surveyResult, opencodeXdg);
          }

          if (surveyResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "resume-survey", surveyResult);
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
            sessionId: surveyResult.sessionId || buildResult.sessionId || existingSessionId || null,
            surveyOutput: surveyResult.output,
          });
        } catch (error: any) {
          console.warn(`[ralph:worker:${this.repo}] Failed to file DX survey issues: ${error?.message ?? String(error)}`);
        }

        await this.recordCheckpoint(task, "survey_complete", surveyResult.sessionId || buildResult.sessionId || existingSessionId);
        this.publishCheckpoint("survey_complete", {
          sessionId: surveyResult.sessionId || buildResult.sessionId || existingSessionId || undefined,
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
          notify: false,
          logMessage: `Task resumed to completion: ${task.name}`,
        });
      });
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Resume failed:`, error);

      if (!error?.ralphRootDirty) {
        const paused = await this.pauseIfGitHubRateLimited(task, "resume", error, {
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
