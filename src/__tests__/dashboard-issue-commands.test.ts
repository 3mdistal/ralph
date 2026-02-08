import { describe, expect, test } from "bun:test";

import {
  isIssueCommandName,
  issueCommandLabel,
  planIssueCmdOps,
  planIssuePriorityOps,
} from "../dashboard/issue-commands";
import {
  RALPH_LABEL_CMD_PAUSE,
  RALPH_LABEL_CMD_QUEUE,
  RALPH_LABEL_CMD_SATISFY,
  RALPH_LABEL_CMD_STOP,
} from "../github-labels";

describe("dashboard issue command helpers", () => {
  test("maps issue commands to canonical labels", () => {
    expect(issueCommandLabel("queue")).toBe(RALPH_LABEL_CMD_QUEUE);
    expect(issueCommandLabel("pause")).toBe(RALPH_LABEL_CMD_PAUSE);
    expect(issueCommandLabel("stop")).toBe(RALPH_LABEL_CMD_STOP);
    expect(issueCommandLabel("satisfy")).toBe(RALPH_LABEL_CMD_SATISFY);
  });

  test("plans cmd ops with conflict removal", () => {
    const planned = planIssueCmdOps("pause");
    expect(planned.label).toBe(RALPH_LABEL_CMD_PAUSE);
    expect(planned.ops).toEqual([
      { action: "add", label: RALPH_LABEL_CMD_PAUSE },
      { action: "remove", label: RALPH_LABEL_CMD_QUEUE },
      { action: "remove", label: RALPH_LABEL_CMD_STOP },
      { action: "remove", label: RALPH_LABEL_CMD_SATISFY },
    ]);
  });

  test("plans canonical priority label ops", () => {
    const planned = planIssuePriorityOps("P1");
    expect(planned.canonicalLabel).toBe("ralph:priority:p1");
    expect(planned.ops[0]).toEqual({ action: "add", label: "ralph:priority:p1" });
    expect(planned.ops.some((op) => op.action === "remove" && op.label === "ralph:priority:p0")).toBe(true);
    expect(planned.ops.some((op) => op.action === "remove" && op.label === "ralph:priority:p2")).toBe(true);
  });

  test("validates issue command names", () => {
    expect(isIssueCommandName("queue")).toBe(true);
    expect(isIssueCommandName("pause")).toBe(true);
    expect(isIssueCommandName("stop")).toBe(true);
    expect(isIssueCommandName("satisfy")).toBe(true);
    expect(isIssueCommandName("noop")).toBe(false);
  });
});
