import { describe, expect, test } from "bun:test";

import { withDashboardSessionOptions, withRunContext } from "../worker/run-context";
import type { DashboardEventContext } from "../dashboard/publisher";
import type { SessionAdapter } from "../run-recording-session-adapter";
import type { RalphRunAttemptKind } from "../state";

function makeSessionAdapter(): SessionAdapter {
  return {
    runAgent: async () => ({ success: true, output: "", sessionId: "ses_1" }),
    continueSession: async () => ({ success: true, output: "", sessionId: "ses_1" }),
    continueCommand: async () => ({ success: true, output: "", sessionId: "ses_1" }),
    getRalphXdgCacheHome: () => "",
  };
}

describe("run context helpers", () => {
  test("withRunContext runs even if run record creation fails", async () => {
    let runCalls = 0;
    let ensureGateCalls = 0;
    const warnings: string[] = [];
    const events: string[] = [];

    const result = await withRunContext({
      task: {
        _path: "orchestration/tasks/1",
        name: "Task 1",
        issue: "3mdistal/ralph#1",
      } as any,
      attemptKind: "process" satisfies RalphRunAttemptKind,
      run: async () => {
        runCalls += 1;
        return { outcome: "success" };
      },
      ports: {
        repo: "3mdistal/ralph",
        getActiveRunId: () => null,
        setActiveRunId: () => {},
        baseSession: makeSessionAdapter(),
        createRunRecordingSessionAdapter: ({ base }) => base,
        createContextRecoveryAdapter: (base) => base,
        withDashboardContext: async (_context, runner) => await runner(),
        withSessionAdapters: async (_next, runner) => await runner(),
        buildDashboardContext: () => ({ repo: "3mdistal/ralph" }) as DashboardEventContext,
        publishDashboardEvent: (event) => events.push(event.type),
        createRunRecord: () => {
          throw new Error("boom");
        },
        ensureRunGateRows: () => {
          ensureGateCalls += 1;
        },
        completeRun: () => {},
        upsertRunGateResult: () => {},
        recordRunGateArtifact: () => {},
        buildRunDetails: () => undefined,
        getPinnedOpencodeProfileName: () => null,
        refreshRalphRunTokenTotals: async () => {},
        getRalphRunTokenTotals: () => null,
        listRalphRunSessionTokenTotals: () => [],
        appendFile: async () => {},
        existsSync: () => false,
        computeAndStoreRunMetrics: async () => {},
        warn: (message) => warnings.push(message),
      },
    });

    expect(runCalls).toBe(1);
    expect(result.outcome).toBe("success");
    expect(ensureGateCalls).toBe(0);
    expect(events.length).toBe(0);
    expect(warnings.length).toBe(1);
  });

  test("withRunContext restores active run + publishes busy/idle", async () => {
    const events: string[] = [];
    let activeRunId: string | null = "run-prev";
    let withSessionAdaptersCalled = false;
    let completedOutcome: string | null = null;
    let completedDetails: any = null;
    let currentBase: SessionAdapter | null = makeSessionAdapter();
    let currentSession: SessionAdapter | null = makeSessionAdapter();

    const baseSession = makeSessionAdapter();
    const recordingBase = makeSessionAdapter();
    const recordingSession = makeSessionAdapter();

    await expect(
      withRunContext({
        task: {
          _path: "orchestration/tasks/2",
          name: "Task 2",
          issue: "3mdistal/ralph#2",
        } as any,
        attemptKind: "process" satisfies RalphRunAttemptKind,
        run: async () => {
          throw new Error("boom");
        },
        ports: {
          repo: "3mdistal/ralph",
          getActiveRunId: () => activeRunId,
          setActiveRunId: (runId) => {
            activeRunId = runId;
          },
          baseSession,
          createRunRecordingSessionAdapter: () => recordingBase,
          createContextRecoveryAdapter: () => recordingSession,
          withDashboardContext: async (_context, runner) => await runner(),
          withSessionAdapters: async (next, runner) => {
            withSessionAdaptersCalled = true;
            const previousBase = currentBase;
            const previousSession = currentSession;
            currentBase = next.baseSession;
            currentSession = next.session;
            try {
              return await runner();
            } finally {
              currentBase = previousBase;
              currentSession = previousSession;
            }
          },
          buildDashboardContext: () => ({ repo: "3mdistal/ralph" }) as DashboardEventContext,
          publishDashboardEvent: (event) => events.push(event.type),
          createRunRecord: () => "run-2",
          ensureRunGateRows: () => {},
          completeRun: (params) => {
            completedOutcome = params.outcome;
            completedDetails = params.details ?? null;
          },
          upsertRunGateResult: () => {},
          recordRunGateArtifact: () => {},
          buildRunDetails: () => undefined,
          getPinnedOpencodeProfileName: () => null,
          refreshRalphRunTokenTotals: async () => {},
          getRalphRunTokenTotals: () => null,
          listRalphRunSessionTokenTotals: () => [],
          appendFile: async () => {},
          existsSync: () => false,
          computeAndStoreRunMetrics: async () => {},
          warn: () => {},
        },
      })
    ).rejects.toThrow("boom");

    expect(activeRunId).toBe("run-prev");
    expect(withSessionAdaptersCalled).toBe(true);
    expect(currentBase).not.toBeNull();
    expect(currentSession).not.toBeNull();
    expect(events).toEqual(["worker.became_busy", "worker.became_idle"]);
    expect(completedOutcome).toBe("failed");
    expect(completedDetails?.stage).toBe("run");
    expect(completedDetails?.errorSummary).toBe("boom");
  });

  test("withDashboardSessionOptions forwards session events", () => {
    const events: any[] = [];
    const seen: any[] = [];
    const context: DashboardEventContext = {
      repo: "3mdistal/ralph",
      taskId: "orchestration/tasks/3",
      workerId: "worker-3",
      sessionId: "ses_default",
    };

    const options = withDashboardSessionOptions({
      options: {
        onEvent: (event) => seen.push(event),
      },
      activeDashboardContext: context,
      publishDashboardEvent: (event) => events.push(event),
    });

    options?.onEvent?.({ type: "text", sessionId: "ses_1", part: { text: 123 } });
    options?.onEvent?.({ type: "text", sessionId: "ses_2", part: { text: "hello" } });
    options?.onEvent?.({ type: "text", part: { text: "fallback" } });

    const eventSessions = events.filter((event) => event.type === "log.opencode.event").map((event) => event.sessionId);
    const textSessions = events.filter((event) => event.type === "log.opencode.text").map((event) => event.sessionId);

    expect(eventSessions).toEqual(["ses_1", "ses_2", "ses_default"]);
    expect(textSessions).toEqual(["ses_1", "ses_2", "ses_default"]);
    expect(events.find((event) => event.type === "log.opencode.text" && event.sessionId === "ses_1")?.data?.text).toBe(
      "123"
    );
    expect(seen.length).toBe(3);
  });

  test("withRunContext fails closed when issue-linked success has no PR evidence", async () => {
    let completedOutcome: any = null;
    let completedDetails: any = null;
    const gateWrites: Array<any> = [];
    const artifacts: Array<any> = [];

    await withRunContext({
      task: {
        _path: "orchestration/tasks/4",
        name: "Task 4",
        issue: "3mdistal/ralph#4",
        "worktree-path": "/tmp/wt-4",
      } as any,
      attemptKind: "process" satisfies RalphRunAttemptKind,
      run: async () => ({ outcome: "success" }),
      ports: {
        repo: "3mdistal/ralph",
        getActiveRunId: () => null,
        setActiveRunId: () => {},
        baseSession: makeSessionAdapter(),
        createRunRecordingSessionAdapter: ({ base }) => base,
        createContextRecoveryAdapter: (base) => base,
        withDashboardContext: async (_context, runner) => await runner(),
        withSessionAdapters: async (_next, runner) => await runner(),
        buildDashboardContext: () => ({ repo: "3mdistal/ralph" }) as DashboardEventContext,
        publishDashboardEvent: () => {},
        createRunRecord: () => "run-4",
        ensureRunGateRows: () => {},
        completeRun: (params) => {
          completedOutcome = params.outcome;
          completedDetails = params.details;
        },
        upsertRunGateResult: (params) => gateWrites.push(params),
        recordRunGateArtifact: (params) => artifacts.push(params),
        buildRunDetails: () => ({ completionKind: "pr" }),
        getPinnedOpencodeProfileName: () => null,
        refreshRalphRunTokenTotals: async () => {},
        getRalphRunTokenTotals: () => null,
        listRalphRunSessionTokenTotals: () => [],
        appendFile: async () => {},
        existsSync: () => false,
        computeAndStoreRunMetrics: async () => {},
        warn: () => {},
      },
    });

    expect(completedOutcome).toBe("escalated");
    expect(completedDetails?.reasonCode).toBe("missing_pr_url");
    expect(gateWrites).toEqual([
      {
        runId: "run-4",
        gate: "pr_evidence",
        status: "fail",
        skipReason: "missing pr_url",
        reason: "cause_code=UNKNOWN",
      },
    ]);
    expect(artifacts.length).toBe(1);
    expect(String(artifacts[0]?.content ?? "")).toContain("Missing PR evidence");
    expect(String(artifacts[0]?.content ?? "")).toContain("PR_EVIDENCE_CAUSE_CODE=UNKNOWN");
  });

  test("withRunContext allows verified success only with explicit terminal reason", async () => {
    let completedOutcome: any = null;
    const gateWrites: Array<any> = [];

    await withRunContext({
      task: {
        _path: "orchestration/tasks/5",
        name: "Task 5",
        issue: "3mdistal/ralph#5",
      } as any,
      attemptKind: "process" satisfies RalphRunAttemptKind,
      run: async () => ({ outcome: "success" }),
      ports: {
        repo: "3mdistal/ralph",
        getActiveRunId: () => null,
        setActiveRunId: () => {},
        baseSession: makeSessionAdapter(),
        createRunRecordingSessionAdapter: ({ base }) => base,
        createContextRecoveryAdapter: (base) => base,
        withDashboardContext: async (_context, runner) => await runner(),
        withSessionAdapters: async (_next, runner) => await runner(),
        buildDashboardContext: () => ({ repo: "3mdistal/ralph" }) as DashboardEventContext,
        publishDashboardEvent: () => {},
        createRunRecord: () => "run-5",
        ensureRunGateRows: () => {},
        completeRun: (params) => {
          completedOutcome = params.outcome;
        },
        upsertRunGateResult: (params) => gateWrites.push(params),
        recordRunGateArtifact: () => {},
        buildRunDetails: () => ({ completionKind: "verified", noPrTerminalReason: "PARENT_VERIFICATION_NO_PR" }),
        getPinnedOpencodeProfileName: () => null,
        refreshRalphRunTokenTotals: async () => {},
        getRalphRunTokenTotals: () => null,
        listRalphRunSessionTokenTotals: () => [],
        appendFile: async () => {},
        existsSync: () => false,
        computeAndStoreRunMetrics: async () => {},
        warn: () => {},
      },
    });

    expect(completedOutcome).toBe("success");
    expect(gateWrites).toEqual([
      {
        runId: "run-5",
        gate: "pr_evidence",
        status: "skipped",
        skipReason: "parent_verification_no_pr",
        reason: "terminal_reason=PARENT_VERIFICATION_NO_PR",
      },
    ]);
  });

  test("withRunContext rejects implicit verified completion with no terminal reason", async () => {
    let completedOutcome: any = null;

    await withRunContext({
      task: {
        _path: "orchestration/tasks/6",
        name: "Task 6",
        issue: "3mdistal/ralph#6",
      } as any,
      attemptKind: "process" satisfies RalphRunAttemptKind,
      run: async () => ({ outcome: "success" }),
      ports: {
        repo: "3mdistal/ralph",
        getActiveRunId: () => null,
        setActiveRunId: () => {},
        baseSession: makeSessionAdapter(),
        createRunRecordingSessionAdapter: ({ base }) => base,
        createContextRecoveryAdapter: (base) => base,
        withDashboardContext: async (_context, runner) => await runner(),
        withSessionAdapters: async (_next, runner) => await runner(),
        buildDashboardContext: () => ({ repo: "3mdistal/ralph" }) as DashboardEventContext,
        publishDashboardEvent: () => {},
        createRunRecord: () => "run-6",
        ensureRunGateRows: () => {},
        completeRun: (params) => {
          completedOutcome = params.outcome;
        },
        upsertRunGateResult: () => {},
        recordRunGateArtifact: () => {},
        buildRunDetails: () => ({ completionKind: "verified" }),
        getPinnedOpencodeProfileName: () => null,
        refreshRalphRunTokenTotals: async () => {},
        getRalphRunTokenTotals: () => null,
        listRalphRunSessionTokenTotals: () => [],
        appendFile: async () => {},
        existsSync: () => false,
        computeAndStoreRunMetrics: async () => {},
        warn: () => {},
      },
    });

    expect(completedOutcome).toBe("escalated");
  });
});
