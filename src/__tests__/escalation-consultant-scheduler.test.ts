import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { createEscalationConsultantScheduler } from "../escalation-consultant/scheduler";
import { closeStateDbForTests } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

function buildEscalationNote(decision: Record<string, unknown>): string {
  return [
    "## Escalation Summary",
    "",
    "| Field | Value |",
    "| Type | watchdog |",
    "| Reason | Tool timed out during build |",
    "",
    "## Resolution",
    "",
    "<!-- Add human guidance here. -->",
    "",
    "## Consultant Decision (machine)",
    "```json",
    JSON.stringify(decision, null, 2),
    "```",
    "",
  ].join("\n");
}

describe("escalation consultant scheduler", () => {
  let tempDir = "";
  let releaseLock: (() => void) | null = null;
  let priorStateDbPath: string | undefined;

  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    tempDir = await mkdtemp(join(tmpdir(), "ralph-consultant-scheduler-"));
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    process.env.RALPH_STATE_DB_PATH = join(tempDir, "state.sqlite");
    closeStateDbForTests();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    closeStateDbForTests();
    if (priorStateDbPath === undefined) {
      delete process.env.RALPH_STATE_DB_PATH;
    } else {
      process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
    }
    releaseLock?.();
  });

  test("auto-resolves once and stays idempotent on repeated ticks", async () => {
    const noteFile = join(tempDir, "escalation-1.md");
    await writeFile(
      noteFile,
      buildEscalationNote({
        schema_version: 2,
        decision: "auto-resolve",
        confidence: "high",
        requires_approval: true,
        current_state: "Worker timed out in a known lane.",
        whats_missing: "No manual resolution needed.",
        options: ["Auto-resolve now", "Escalate to human"],
        recommendation: "Auto-resolve now",
        questions: ["Proceed with auto-resolve?"],
        proposed_resolution_text: "Retry from the same session with the known deterministic remediation.",
        reason: "Routine timeout",
        followups: [],
      }),
      "utf8"
    );

    const updateTaskStatus = mock(async () => true);
    const editEscalation = mock(async () => ({ ok: true as const }));

    const scheduler = createEscalationConsultantScheduler({
      getEscalationsByStatus: async () => [
        {
          _path: "escalation-1.md",
          _name: "escalation-1",
          type: "agent-escalation",
          status: "pending",
          repo: "3mdistal/ralph",
          issue: "3mdistal/ralph#207",
          "task-path": "orchestration/tasks/t-207.md",
          "escalation-type": "watchdog",
        },
      ],
      getVaultPath: () => tempDir,
      isShuttingDown: () => false,
      allowModelSend: async () => false,
      repoPath: () => tempDir,
      editEscalation,
      getTaskByPath: async () =>
        ({
          _path: "orchestration/tasks/t-207.md",
          _name: "t-207",
          type: "agent-task",
          "creation-date": "2026-02-08",
          scope: "builder",
          issue: "3mdistal/ralph#207",
          repo: "3mdistal/ralph",
          status: "escalated",
          name: "Task 207",
        }) as any,
      updateTaskStatus,
      nowIso: () => "2026-02-08T20:00:00.000Z",
    });

    await scheduler.tick();
    await scheduler.tick();

    const editCall = editEscalation.mock.calls[0] as any;
    const statusCall = updateTaskStatus.mock.calls[0] as any;

    expect(editEscalation).toHaveBeenCalledTimes(1);
    expect(editCall?.[1]).toEqual({ status: "resolved" });
    expect(updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(statusCall?.[2]?.["auto-resolve-last-at"]).toBe("2026-02-08T20:00:00.000Z");

    const updated = await readFile(noteFile, "utf8");
    expect(updated).toContain("Retry from the same session with the known deterministic remediation.");
  });

  test("writes suppression marker with injected timestamp", async () => {
    const noteFile = join(tempDir, "escalation-2.md");
    await writeFile(
      noteFile,
      buildEscalationNote({
        schema_version: 2,
        decision: "needs-human",
        confidence: "high",
        requires_approval: true,
        current_state: "Needs operator judgment.",
        whats_missing: "Approval required.",
        options: ["Ask human", "Defer"],
        recommendation: "Ask human",
        questions: ["Approve?"],
        proposed_resolution_text: "Wait for operator",
        reason: "Needs approval",
        followups: [],
      }),
      "utf8"
    );

    const scheduler = createEscalationConsultantScheduler({
      getEscalationsByStatus: async () => [
        {
          _path: "escalation-2.md",
          _name: "escalation-2",
          type: "agent-escalation",
          status: "pending",
          repo: "3mdistal/ralph",
          issue: "3mdistal/ralph#207",
          "task-path": "orchestration/tasks/t-207.md",
          "escalation-type": "watchdog",
        },
      ],
      getVaultPath: () => tempDir,
      isShuttingDown: () => false,
      allowModelSend: async () => false,
      repoPath: () => tempDir,
      editEscalation: async () => ({ ok: true }),
      getTaskByPath: async () => null,
      updateTaskStatus: async () => true,
      nowIso: () => "2026-02-08T20:01:02.000Z",
    });

    await scheduler.tick();

    const updated = await readFile(noteFile, "utf8");
    expect(updated).toContain("ralph-autopilot:suppressed");
    expect(updated).toContain("reason=decision-not-auto-resolve");
    expect(updated).toContain("at=2026-02-08T20:01:02.000Z");
  });
});
