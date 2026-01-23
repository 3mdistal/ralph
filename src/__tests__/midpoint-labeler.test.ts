import { describe, expect, mock, test } from "bun:test";

import { RALPH_LABEL_IN_PROGRESS } from "../github-labels";
import { applyMidpointLabelsBestEffort } from "../midpoint-labeler";

const issueRef = {
  owner: "3mdistal",
  name: "ralph",
  number: 123,
  repo: "3mdistal/ralph",
};

describe("midpoint labeler", () => {
  test("clears in-progress for non-bot merge", async () => {
    const addIssueLabelMock = mock(async () => {});
    const removeIssueLabelMock = mock(async () => {});
    const notifyErrorMock = mock(async () => {});

    await applyMidpointLabelsBestEffort({
      issueRef,
      issue: "3mdistal/ralph#123",
      taskName: "Test task",
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      botBranch: "bot/integration",
      baseBranch: "release",
      fetchDefaultBranch: async () => "main",
      fetchBaseBranch: async () => "release",
      addIssueLabel: addIssueLabelMock,
      removeIssueLabel: removeIssueLabelMock,
      notifyError: notifyErrorMock,
    });

    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(removeIssueLabelMock).toHaveBeenCalledWith(issueRef, RALPH_LABEL_IN_PROGRESS);
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  test("notifies on midpoint label failures", async () => {
    const addIssueLabelMock = mock(async () => {
      throw new Error("label add failed");
    });
    const removeIssueLabelMock = mock(async () => {
      throw new Error("label remove failed");
    });
    const notifyErrorMock = mock(async () => {});
    const warnMock = mock(() => {});

    await applyMidpointLabelsBestEffort({
      issueRef,
      issue: "3mdistal/ralph#123",
      taskName: "Test task",
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      botBranch: "bot/integration",
      baseBranch: "bot/integration",
      fetchDefaultBranch: async () => "main",
      fetchBaseBranch: async () => "bot/integration",
      addIssueLabel: addIssueLabelMock,
      removeIssueLabel: removeIssueLabelMock,
      notifyError: notifyErrorMock,
      warn: warnMock,
    });

    expect(addIssueLabelMock).toHaveBeenCalled();
    expect(removeIssueLabelMock).toHaveBeenCalled();
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalled();
  });
});
