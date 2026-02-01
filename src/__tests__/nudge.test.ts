import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { buildNudgePreview, drainQueuedNudges, getPendingNudges, getNudgeQueueState, queueNudge, recordDeliveryAttempt } from "../nudge";

describe("ralph nudge", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "ralph-sessions-"));
    process.env.RALPH_SESSIONS_DIR = sessionsDir;
  });

  afterEach(async () => {
    delete process.env.RALPH_SESSIONS_DIR;
    await rm(sessionsDir, { recursive: true, force: true });
  });

  test("queueNudge creates a pending nudge", async () => {
    const sessionId = "ses_test_1";
    const id = await queueNudge(sessionId, "hello", { taskRef: "task-1" });

    const pending = await getPendingNudges(sessionId);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].message).toBe("hello");
    expect(pending[0].failedAttempts).toBe(0);
  });

  test("successful delivery removes from pending", async () => {
    const sessionId = "ses_test_2";
    const id = await queueNudge(sessionId, "deliver-me");

    await recordDeliveryAttempt(sessionId, id, { success: true });

    const pending = await getPendingNudges(sessionId);
    expect(pending.length).toBe(0);
  });

  test("failed deliveries increment attempts and eventually stop pending", async () => {
    const sessionId = "ses_test_3";
    const id = await queueNudge(sessionId, "nope");

    await recordDeliveryAttempt(sessionId, id, { success: false, error: "fail-1" });
    await recordDeliveryAttempt(sessionId, id, { success: false, error: "fail-2" });

    const pendingAfterTwo = await getPendingNudges(sessionId, 3);
    expect(pendingAfterTwo.length).toBe(1);
    expect(pendingAfterTwo[0].failedAttempts).toBe(2);

    await recordDeliveryAttempt(sessionId, id, { success: false, error: "fail-3" });

    const pendingAfterThree = await getPendingNudges(sessionId, 3);
    expect(pendingAfterThree.length).toBe(0);
  });

  test("drainQueuedNudges delivers sequentially and stops on error", async () => {
    const sessionId = "ses_test_4";
    await queueNudge(sessionId, "first");
    await queueNudge(sessionId, "second");

    const delivered: string[] = [];

    const firstDrain = await drainQueuedNudges(sessionId, async (msg) => {
      delivered.push(msg);
      if (msg === "second") return { kind: "failed", error: "boom" };
      return { kind: "delivered" };
    });

    expect(firstDrain.attempted).toBe(2);
    expect(firstDrain.delivered).toBe(1);
    expect(firstDrain.stoppedOnError).toBe(true);
    expect(delivered).toEqual(["first", "second"]);

    // Second nudge should remain pending (attempts=1 < maxAttempts)
    const pending = await getPendingNudges(sessionId, 3);
    expect(pending.length).toBe(1);
    expect(pending[0].message).toBe("second");
  });

  test("drainQueuedNudges defers without burning attempts", async () => {
    const sessionId = "ses_test_5";
    await queueNudge(sessionId, "hold");

    const drain = await drainQueuedNudges(sessionId, async () => ({ kind: "deferred", reason: "paused" }));
    expect(drain.deferred).toBe(true);
    expect(drain.attempted).toBe(0);
    expect(drain.delivered).toBe(0);

    const pending = await getPendingNudges(sessionId, 3);
    expect(pending.length).toBe(1);
    expect(pending[0].failedAttempts).toBe(0);
  });

  test("blocked head-of-line prevents later delivery", async () => {
    const sessionId = "ses_test_6";
    const first = await queueNudge(sessionId, "first");
    await queueNudge(sessionId, "second");

    await recordDeliveryAttempt(sessionId, first, { success: false, error: "fail-1" });
    await recordDeliveryAttempt(sessionId, first, { success: false, error: "fail-2" });
    await recordDeliveryAttempt(sessionId, first, { success: false, error: "fail-3" });

    let deliveries = 0;
    const drain = await drainQueuedNudges(sessionId, async () => {
      deliveries += 1;
      return { kind: "delivered" };
    });

    expect(drain.blocked).toBe(true);
    expect(drain.attempted).toBe(0);
    expect(deliveries).toBe(0);

    const state = await getNudgeQueueState(sessionId, 3);
    expect(state.blocked?.id).toBe(first);
  });

  test("buildNudgePreview redacts sensitive text", () => {
    const preview = buildNudgePreview("token=ghp_1234567890123456789012345");
    expect(preview.preview).toContain("REDACTED");
    expect(preview.preview).not.toContain("ghp_1234567890123456789012345");
    expect(preview.len).toBe(35);
  });
});
