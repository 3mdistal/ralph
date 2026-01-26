import { afterAll, describe, expect, mock, test } from "bun:test";

const recordRalphRunSessionUseMock = mock(async (_input: any) => {});

mock.module("../state", () => ({
  recordRalphRunSessionUse: recordRalphRunSessionUseMock,
}));

import { createRunRecordingSessionAdapter, type SessionAdapter } from "../run-recording-session-adapter";

afterAll(() => {
  mock.restore();
});

describe("run recording session adapter", () => {
  test("records session usage for runAgent/continueSession/continueCommand", async () => {
    const runAgentMock = mock(async () => ({ sessionId: "ses_plan", success: true, output: "ok" }));
    const continueSessionMock = mock(async () => ({ sessionId: "", success: true, output: "ok" }));
    const continueCommandMock = mock(async () => ({ sessionId: "ses_cmd", success: true, output: "ok" }));

    const base: SessionAdapter = {
      runAgent: runAgentMock,
      continueSession: continueSessionMock,
      continueCommand: continueCommandMock,
      getRalphXdgCacheHome: () => "/tmp",
    };

    const adapter = createRunRecordingSessionAdapter({
      base,
      runId: "run-123",
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#1",
    });

    await adapter.runAgent("/tmp", "ralph-plan", "plan", {
      introspection: { stepTitle: "plan" },
    });

    await adapter.continueSession("/tmp", "ses_continue", "resume", {
      introspection: { stepTitle: "resume" },
    });

    await adapter.continueCommand("/tmp", "ses_cmd", "survey", [], {});

    expect(recordRalphRunSessionUseMock).toHaveBeenCalledTimes(3);

    const first = recordRalphRunSessionUseMock.mock.calls[0]?.[0] as any;
    expect(first.runId).toBe("run-123");
    expect(first.sessionId).toBe("ses_plan");
    expect(first.stepTitle).toBe("plan");
    expect(first.agent).toBe("ralph-plan");

    const second = recordRalphRunSessionUseMock.mock.calls[1]?.[0] as any;
    expect(second.sessionId).toBe("ses_continue");
    expect(second.stepTitle).toBe("resume");

    const third = recordRalphRunSessionUseMock.mock.calls[2]?.[0] as any;
    expect(third.sessionId).toBe("ses_cmd");
    expect(third.stepTitle).toBe("command:survey");
  });
});
