import { $ } from "bun";
import { appendFile, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { homedir } from "os";

import { type AgentTask, updateTaskStatus } from "./queue";
import { loadConfig, getRepoBotBranch } from "./config";
import { runCommand, continueSession, continueCommand } from "./session";
import { parseRoutingDecision, hasProductGap, extractPrUrl, type RoutingDecision } from "./routing";
import { notifyEscalation, notifyError, notifyTaskComplete, type EscalationContext } from "./notify";

// Ralph introspection logs location
const RALPH_SESSIONS_DIR = join(homedir(), ".ralph", "sessions");

// Anomaly detection thresholds
const ANOMALY_BURST_THRESHOLD = 50; // Abort if this many anomalies detected
const MAX_ANOMALY_ABORTS = 3; // Max times to abort and retry before escalating

interface IntrospectionSummary {
  sessionId: string;
  endTime: number;
  toolResultAsTextCount: number;
  totalToolCalls: number;
  stepCount: number;
  hasAnomalies: boolean;
  recentTools: string[];
}

interface LiveAnomalyCount {
  total: number;
  recentBurst: boolean;
}

async function readIntrospectionSummary(sessionId: string): Promise<IntrospectionSummary | null> {
  const summaryPath = join(RALPH_SESSIONS_DIR, sessionId, "summary.json");
  if (!existsSync(summaryPath)) return null;
  
  try {
    const content = await readFile(summaryPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Read live anomaly count from the session's events.jsonl.
 * Returns total count and whether there's been a recent burst.
 */
async function readLiveAnomalyCount(sessionId: string): Promise<LiveAnomalyCount> {
  const eventsPath = join(RALPH_SESSIONS_DIR, sessionId, "events.jsonl");
  if (!existsSync(eventsPath)) return { total: 0, recentBurst: false };

  try {
    const content = await readFile(eventsPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    
    let total = 0;
    const recentAnomalies: number[] = [];
    const now = Date.now();
    const BURST_WINDOW_MS = 10000; // 10 seconds
    
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "anomaly") {
          total++;
          if (event.ts && (now - event.ts) < BURST_WINDOW_MS) {
            recentAnomalies.push(event.ts);
          }
        }
      } catch {
        // ignore malformed lines
      }
    }
    
    // A burst is 20+ anomalies in the last 10 seconds
    const recentBurst = recentAnomalies.length >= 20;
    
    return { total, recentBurst };
  } catch {
    return { total: 0, recentBurst: false };
  }
}

async function cleanupIntrospectionLogs(sessionId: string): Promise<void> {
  const sessionDir = join(RALPH_SESSIONS_DIR, sessionId);
  if (existsSync(sessionDir)) {
    try {
      await rm(sessionDir, { recursive: true });
    } catch (e) {
      console.warn(`[ralph:worker] Failed to cleanup introspection logs: ${e}`);
    }
  }
}

export interface AgentRun {
  taskName: string;
  repo: string;
  outcome: "success" | "escalated" | "failed";
  pr?: string;
  sessionId?: string;
  escalationReason?: string;
  surveyResults?: string;
}

function safeNoteName(name: string): string {
  return name
    .replace(/[\\/]/g, " - ")
    .replace(/[:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveVaultPath(p: string): string {
  const vault = loadConfig().bwrbVault;
  return isAbsolute(p) ? p : join(vault, p);
}

export class RepoWorker {
  public busy = false;

  constructor(public readonly repo: string, public readonly repoPath: string) {}

  /**
   * Fetch labels for a GitHub issue
   */
  private async getIssueLabels(issue: string): Promise<string[]> {
    // issue format: "owner/repo#123"
    const match = issue.match(/^([^#]+)#(\d+)$/);
    if (!match) return [];
    
    const [, repo, number] = match;
    try {
      const result = await $`gh issue view ${number} --repo ${repo} --json labels`.quiet();
      const data = JSON.parse(result.stdout.toString());
      return data.labels?.map((l: any) => l.name) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Determine if we should escalate based on routing decision and task type.
   * Implementation tasks (dx, refactor, bug) get more lenient treatment.
   */
  private shouldEscalate(
    routing: RoutingDecision | null,
    hasGap: boolean,
    isImplementationTask: boolean
  ): boolean {
    // No routing decision parsed - don't escalate, let it proceed
    if (!routing) return false;

    // Explicit escalate decision with high confidence - always escalate
    if (routing.decision === "escalate" && routing.confidence === "high") {
      return true;
    }

    // For implementation tasks, only escalate on explicit "escalate" + NOT low-level details
    if (isImplementationTask) {
      // Check if the escalation reason is about low-level implementation details
      const reason = routing.escalation_reason?.toLowerCase() ?? "";
      const isLowLevelQuestion = 
        reason.includes("error message") ||
        reason.includes("error format") ||
        reason.includes("warning") ||
        reason.includes("json output") ||
        reason.includes("json mode") ||
        reason.includes("wording");
      
      if (isLowLevelQuestion) {
        console.log(`[ralph:worker:${this.repo}] Skipping escalation for low-level implementation question`);
        return false;
      }
      
      // For implementation tasks, ignore "product gap" signals unless explicit escalate
      if (hasGap && routing.decision !== "escalate") {
        console.log(`[ralph:worker:${this.repo}] Ignoring product gap for implementation task`);
        return false;
      }
    }

    // Default logic for non-implementation tasks
    return routing.decision === "escalate" || hasGap || routing.confidence === "low";
  }

  async resumeTask(task: AgentTask): Promise<AgentRun> {
    const startTime = new Date();
    console.log(`[ralph:worker:${this.repo}] Resuming task: ${task.name}`);

    const issueMatch = task.issue.match(/#(\d+)$/);
    const cacheKey = issueMatch?.[1] ?? task._name;

    const existingSessionId = task["session-id"]?.trim();
    if (!existingSessionId) {
      const reason = "In-progress task has no session-id; cannot resume";
      console.warn(`[ralph:worker:${this.repo}] ${reason}: ${task.name}`);
      await updateTaskStatus(task, "queued", { "session-id": "" });
      return { taskName: task.name, repo: this.repo, outcome: "failed", escalationReason: reason };
    }

    this.busy = true;

    try {
      const botBranch = getRepoBotBranch(this.repo);
      const resumeMessage =
        "Ralph restarted while this task was in progress. " +
        "Resume from where you left off. " +
        `If you already created a PR, paste the PR URL. Otherwise continue implementing and create a PR targeting the '${botBranch}' branch.`;

      let buildResult = await continueSession(this.repoPath, existingSessionId, resumeMessage, {
        repo: this.repo,
        cacheKey,
      });
      if (!buildResult.success) {
        const reason = `Failed to resume OpenCode session ${existingSessionId}: ${buildResult.output}`;
        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        await updateTaskStatus(task, "escalated");
        await notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          reason,
          escalationType: "other",
        });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: existingSessionId,
          escalationReason: reason,
        };
      }

      if (buildResult.sessionId) {
        await updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      // Extract PR URL (with retry loop if agent stopped without creating PR)
      const MAX_CONTINUE_RETRIES = 5;
      let prUrl = extractPrUrl(buildResult.output);
      let continueAttempts = 0;
      let anomalyAborts = 0;
      let lastAnomalyCount = 0;

      while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
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

            await updateTaskStatus(task, "escalated");
            await notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              reason,
              escalationType: "other",
              planOutput: buildResult.output,
            });

            return {
              taskName: task.name,
              repo: this.repo,
              outcome: "escalated",
              sessionId: buildResult.sessionId,
              escalationReason: reason,
            };
          }

          console.log(`[ralph:worker:${this.repo}] Sending loop-break nudge...`);
          buildResult = await continueSession(
            this.repoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            { repo: this.repo, cacheKey }
          );

          lastAnomalyCount = anomalyStatus.total;

          if (buildResult.success) {
            prUrl = extractPrUrl(buildResult.output);
          }

          continue;
        }

        continueAttempts++;
        console.log(
          `[ralph:worker:${this.repo}] No PR URL found, sending "Continue." (attempt ${continueAttempts}/${MAX_CONTINUE_RETRIES})`
        );

        buildResult = await continueSession(this.repoPath, buildResult.sessionId, "Continue.", { repo: this.repo, cacheKey });
        if (!buildResult.success) {
          console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
          break;
        }

        prUrl = extractPrUrl(buildResult.output);
      }

      if (!prUrl) {
        const reason = `Agent completed but did not create a PR after ${continueAttempts} continue attempts`;
        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        await updateTaskStatus(task, "escalated");
        await notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          reason,
          escalationType: "other",
          planOutput: buildResult.output,
        });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: buildResult.sessionId,
          escalationReason: reason,
        };
      }

      console.log(`[ralph:worker:${this.repo}] Approving merge for ${prUrl}`);
      const mergeResult = await continueSession(
        this.repoPath,
        buildResult.sessionId,
        "Looks good. Merge the PR and clean up the worktree.",
        { repo: this.repo, cacheKey }
      );
      if (!mergeResult.success) {
        console.warn(`[ralph:worker:${this.repo}] Merge may have failed: ${mergeResult.output}`);
      }

      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const surveyResult = await continueCommand(this.repoPath, buildResult.sessionId, "survey", [], {
        repo: this.repo,
        cacheKey,
      });

      const endTime = new Date();
      await this.createAgentRun(task, {
        sessionId: buildResult.sessionId,
        pr: prUrl,
        outcome: "success",
        started: startTime,
        completed: endTime,
        surveyResults: surveyResult.output,
      });

      await updateTaskStatus(task, "done", {
        "completed-at": endTime.toISOString().split("T")[0],
        "session-id": "",
      });

      console.log(`[ralph:worker:${this.repo}] Task resumed to completion: ${task.name}`);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "success",
        pr: prUrl ?? undefined,
        sessionId: buildResult.sessionId,
      };
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Resume failed:`, error);

      await updateTaskStatus(task, "blocked");
      await notifyError(`Resuming ${task.name}`, error?.message ?? String(error), task.name);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
      this.busy = false;
    }
  }

  async processTask(task: AgentTask): Promise<AgentRun> {
    const startTime = new Date();
    console.log(`[ralph:worker:${this.repo}] Starting task: ${task.name}`);

    this.busy = true;

    try {
      // 1. Mark task in-progress (use _path to avoid ambiguous names)
      const markedInProgress = await updateTaskStatus(task, "in-progress", {
        "assigned-at": startTime.toISOString().split("T")[0],
      });
      if (!markedInProgress) {
        throw new Error("Failed to mark task in-progress (bwrb edit failed)");
      }

      // 2. Extract issue number (e.g., "3mdistal/bwrb#245" -> "245")
      const issueMatch = task.issue.match(/#(\d+)$/);
      if (!issueMatch) throw new Error(`Invalid issue format: ${task.issue}`);
      const issueNumber = issueMatch[1];
      const cacheKey = issueNumber;

      // 3. Fetch issue labels to adjust escalation sensitivity
      const issueLabels = await this.getIssueLabels(task.issue);
      const isImplementationTask = issueLabels.some(l => 
        ["dx", "refactor", "bug", "chore", "test"].includes(l.toLowerCase())
      );
      
      // 4. Run configured command: next-task
      console.log(`[ralph:worker:${this.repo}] Running /next-task ${issueNumber}`);

      // Transient OpenCode cache races can cause ENOENT during module imports (e.g. zod locales).
      // With per-run cache isolation this should be rare, but we still retry once for robustness.
      const isTransientCacheENOENT = (output: string) =>
        /ENOENT\s+reading\s+"[^"]*\/\.cache\/opencode\/node_modules\//.test(output) ||
        /ENOENT\s+reading\s+"[^"]*zod\/v4\/locales\//.test(output);

      let planResult = await runCommand(this.repoPath, "next-task", [issueNumber], {
        repo: this.repo,
        cacheKey,
      });

      if (!planResult.success && isTransientCacheENOENT(planResult.output)) {
        console.warn(`[ralph:worker:${this.repo}] /next-task hit transient cache ENOENT; retrying once...`);
        await new Promise((r) => setTimeout(r, 750));
        planResult = await runCommand(this.repoPath, "next-task", [issueNumber], {
          repo: this.repo,
          cacheKey,
        });
      }

      if (!planResult.success) {
        throw new Error(`/next-task failed: ${planResult.output}`);
      }

      // Persist OpenCode session ID for crash recovery
      if (planResult.sessionId) {
        await updateTaskStatus(task, "in-progress", { "session-id": planResult.sessionId });
      }

      // 5. Parse routing decision
      const routing = parseRoutingDecision(planResult.output);
      const hasGap = hasProductGap(planResult.output);

      // 6. Decide whether to escalate
      // For implementation tasks (dx, refactor, bug), be more lenient
      const shouldEscalate = this.shouldEscalate(routing, hasGap, isImplementationTask);
      
      if (shouldEscalate) {
        const reason =
          routing?.escalation_reason || (hasGap ? "Product documentation gap identified" : "Low confidence in plan");

        // Determine escalation type
        let escalationType: EscalationContext["escalationType"] = "other";
        if (hasGap) {
          escalationType = "product-gap";
        } else if (routing?.confidence === "low") {
          escalationType = "low-confidence";
        } else if (routing?.escalation_reason?.toLowerCase().includes("ambiguous")) {
          escalationType = "ambiguous-requirements";
        } else if (routing?.escalation_reason?.toLowerCase().includes("blocked")) {
          escalationType = "blocked";
        }

        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        await updateTaskStatus(task, "escalated");
        await notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
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
        });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: planResult.sessionId,
          escalationReason: reason,
        };
      }

      // 6. Proceed with build
      console.log(`[ralph:worker:${this.repo}] Proceeding with build...`);
      const botBranch = getRepoBotBranch(this.repo);
      const proceedMessage = `Proceed with implementation. Target your PR to the \`${botBranch}\` branch.`;

      let buildResult = await continueSession(this.repoPath, planResult.sessionId, proceedMessage, {
        repo: this.repo,
        cacheKey,
      });
      if (!buildResult.success) throw new Error(`Build failed: ${buildResult.output}`);

      // Keep the latest session ID persisted
      if (buildResult.sessionId) {
        await updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      // 7. Extract PR URL (with retry loop if agent stopped without creating PR)
      // Also monitors for anomaly bursts (GPT tool-result-as-text loop)
      const MAX_CONTINUE_RETRIES = 5;
      let prUrl = extractPrUrl(buildResult.output);
      let continueAttempts = 0;
      let anomalyAborts = 0;
      let lastAnomalyCount = 0;

      while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
        // Check for anomaly burst before continuing
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
            // Too many anomaly aborts - escalate
            const reason = `Agent stuck in tool-result-as-text loop (${anomalyStatus.total} anomalies detected, aborted ${anomalyAborts} times)`;
            console.log(`[ralph:worker:${this.repo}] Escalating due to repeated anomaly loops`);

            await updateTaskStatus(task, "escalated");
            await notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              reason,
              escalationType: "other",
              planOutput: buildResult.output,
            });

            return {
              taskName: task.name,
              repo: this.repo,
              outcome: "escalated",
              sessionId: buildResult.sessionId,
              escalationReason: reason,
            };
          }

          // Send a specific nudge to break the loop
          console.log(`[ralph:worker:${this.repo}] Sending loop-break nudge...`);
          buildResult = await continueSession(
            this.repoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            { repo: this.repo, cacheKey }
          );
          
          // Reset anomaly tracking for fresh window
          lastAnomalyCount = anomalyStatus.total;
          
          if (buildResult.success) {
            prUrl = extractPrUrl(buildResult.output);
          }
          continue;
        }

        continueAttempts++;
        console.log(`[ralph:worker:${this.repo}] No PR URL found, sending "Continue." (attempt ${continueAttempts}/${MAX_CONTINUE_RETRIES})`);
        
        buildResult = await continueSession(this.repoPath, buildResult.sessionId, "Continue.", { repo: this.repo, cacheKey });
        if (!buildResult.success) {
          console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
          break;
        }
        
        prUrl = extractPrUrl(buildResult.output);
      }

      if (!prUrl) {
        // Escalate if we still don't have a PR after retries
        const reason = `Agent completed but did not create a PR after ${continueAttempts} continue attempts`;
        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        await updateTaskStatus(task, "escalated");
        await notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          reason,
          escalationType: "other",
          planOutput: buildResult.output,
        });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: buildResult.sessionId,
          escalationReason: reason,
        };
      }

      // 8. Ask agent to merge
      if (prUrl) {
        console.log(`[ralph:worker:${this.repo}] Approving merge for ${prUrl}`);
        const mergeResult = await continueSession(
          this.repoPath,
          buildResult.sessionId,
          "Looks good. Merge the PR and clean up the worktree.",
          { repo: this.repo, cacheKey }
        );
        if (!mergeResult.success) {
          console.warn(`[ralph:worker:${this.repo}] Merge may have failed: ${mergeResult.output}`);
        }
      }

      // 9. Run survey (configured command)
      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const surveyResult = await continueCommand(this.repoPath, buildResult.sessionId, "survey", [], {
        repo: this.repo,
        cacheKey,
      });

      // 10. Create agent-run note
      const endTime = new Date();
      await this.createAgentRun(task, {
        sessionId: buildResult.sessionId,
        pr: prUrl,
        outcome: "success",
        started: startTime,
        completed: endTime,
        surveyResults: surveyResult.output,
      });

      // 11. Mark task done
      await updateTaskStatus(task, "done", {
        "completed-at": endTime.toISOString().split("T")[0],
        "session-id": "",
      });

      // 12. Send desktop notification for completion
      await notifyTaskComplete(task.name, this.repo, prUrl ?? undefined);

      console.log(`[ralph:worker:${this.repo}] Task completed: ${task.name}`);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "success",
        pr: prUrl ?? undefined,
        sessionId: buildResult.sessionId,
      };
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Task failed:`, error);

      await updateTaskStatus(task, "blocked");
      await notifyError(`Processing ${task.name}`, error?.message ?? String(error), task.name);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
      this.busy = false;
    }
  }

  private async createAgentRun(
    task: AgentTask,
    data: {
      sessionId: string;
      pr?: string | null;
      outcome: "success" | "escalated" | "failed";
      started: Date;
      completed: Date;
      surveyResults?: string;
    }
  ): Promise<void> {
    const vault = loadConfig().bwrbVault;
    const today = data.completed.toISOString().split("T")[0];
    const shortIssue = task.issue.split("/").pop() || task.issue;

    const runName = safeNoteName(`Run for ${shortIssue} - ${task.name.slice(0, 40)}`);

    const json = JSON.stringify({
      name: runName,
      task: `[[${task._name}]]`,  // Use _name (filename) not name (display) for wikilinks
      started: data.started.toISOString().split("T")[0],
      completed: today,
      outcome: data.outcome,
      pr: data.pr || "",
      "creation-date": today,
      scope: "builder",
    });

    try {
      const result = await $`bwrb new agent-run --json ${json}`.cwd(vault).quiet();
      const output = JSON.parse(result.stdout.toString());

      if (output.success && output.path) {
        const notePath = resolveVaultPath(output.path);
        const bodySections: string[] = [];

        // Add introspection summary if available
        const introspection = await readIntrospectionSummary(data.sessionId);
        if (introspection) {
          bodySections.push(
            "## Session Summary",
            "",
            `- **Steps:** ${introspection.stepCount}`,
            `- **Tool calls:** ${introspection.totalToolCalls}`,
            `- **Anomalies:** ${introspection.hasAnomalies ? `Yes (${introspection.toolResultAsTextCount} tool-result-as-text)` : "None"}`,
            `- **Recent tools:** ${introspection.recentTools.join(", ") || "none"}`,
            ""
          );
        }

        // Add survey results
        if (data.surveyResults) {
          bodySections.push("## Survey Results", "", data.surveyResults, "");
        }

        if (bodySections.length > 0) {
          await appendFile(notePath, "\n" + bodySections.join("\n"), "utf8");
        }

        // Clean up introspection logs
        await cleanupIntrospectionLogs(data.sessionId);
      }

      console.log(`[ralph:worker:${this.repo}] Created agent-run note`);
    } catch (e) {
      console.error(`[ralph:worker:${this.repo}] Failed to create agent-run:`, e);
    }
  }
}
