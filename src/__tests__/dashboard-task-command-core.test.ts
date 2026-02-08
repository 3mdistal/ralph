import { describe, expect, test } from "bun:test";

import {
  buildTaskStatusCmdLabelMutation,
  mapTaskStatusInputToCmdLabel,
  parseGitHubTaskId,
} from "../dashboard/task-command-core";
import {
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_CMD_SATISFY,
  RALPH_LABEL_CMD_STOP,
} from "../github-labels";

describe("dashboard task command core", () => {
  test("maps status aliases to command labels", () => {
    expect(mapTaskStatusInputToCmdLabel("queue")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_QUEUE });
    expect(mapTaskStatusInputToCmdLabel(" queued ")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_QUEUE });
    expect(mapTaskStatusInputToCmdLabel("pause")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_PAUSE });
    expect(mapTaskStatusInputToCmdLabel("paused")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_PAUSE });
    expect(mapTaskStatusInputToCmdLabel("stop")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_STOP });
    expect(mapTaskStatusInputToCmdLabel("stopped")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_STOP });
    expect(mapTaskStatusInputToCmdLabel("satisfy")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_SATISFY });
    expect(mapTaskStatusInputToCmdLabel("satisfied")).toMatchObject({ ok: true, cmdLabel: RALPH_LABEL_CMD_SATISFY });
  });

  test("rejects unsupported status", () => {
    const result = mapTaskStatusInputToCmdLabel("in-progress");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bad_request");
  });

  test("parses github task ids", () => {
    const result = parseGitHubTaskId("github:3mdistal/ralph#37");
    expect(result).toEqual({ ok: true, repo: "3mdistal/ralph", issueNumber: 37, issueRef: "3mdistal/ralph#37" });
  });

  test("rejects malformed and unsupported task ids", () => {
    const unsupported = parseGitHubTaskId("orchestration/tasks/foo");
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.code).toBe("unsupported_task_id");

    const malformed = parseGitHubTaskId("github:bad-format");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("bad_request");
  });

  test("builds cmd label mutation with single target", () => {
    const mutation = buildTaskStatusCmdLabelMutation(RALPH_LABEL_CMD_PAUSE);
    expect(mutation.add).toEqual([RALPH_LABEL_CMD_PAUSE]);
    expect(mutation.remove).toContain(RALPH_LABEL_CMD_QUEUE);
    expect(mutation.remove).toContain(RALPH_LABEL_CMD_STOP);
    expect(mutation.remove).toContain(RALPH_LABEL_CMD_SATISFY);
    expect(mutation.remove).not.toContain(RALPH_LABEL_CMD_PAUSE);
  });
});
