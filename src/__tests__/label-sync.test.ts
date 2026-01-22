import { describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";

describe("ensureRalphWorkflowLabelsOnce", () => {
  test("clears cached promise after failure", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const listLabelSpecs = mock(async () => {
      throw new Error("boom");
    });
    const createLabel = mock(async () => {});
    const updateLabel = mock(async () => {});

    (worker as any).github = { listLabelSpecs, createLabel, updateLabel };

    await expect((worker as any).ensureRalphWorkflowLabelsOnce()).rejects.toThrow("boom");

    const listLabelSpecsSecond = mock(async () => []);
    (worker as any).github = { listLabelSpecs: listLabelSpecsSecond, createLabel, updateLabel };

    await expect((worker as any).ensureRalphWorkflowLabelsOnce()).resolves.toBeUndefined();
    expect(listLabelSpecsSecond).toHaveBeenCalledTimes(1);
  });

  test("propagates create label failures", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const listLabelSpecs = mock(async () => []);
    const createLabel = mock(async () => {
      throw new Error("create failed");
    });
    const updateLabel = mock(async () => {});

    (worker as any).github = { listLabelSpecs, createLabel, updateLabel };

    await expect((worker as any).ensureRalphWorkflowLabelsOnce()).rejects.toThrow("create failed");
    expect(listLabelSpecs).toHaveBeenCalledTimes(1);
    expect(createLabel).toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
  });
});
