import { describe, expect, test } from "bun:test";

import { computeRalphLabelSync, RALPH_WORKFLOW_LABELS } from "../github-labels";

describe("computeRalphLabelSync", () => {
  test("creates all workflow labels when none exist", () => {
    const { toCreate, toUpdate } = computeRalphLabelSync([]);
    expect(toCreate.map((l) => l.name)).toEqual(RALPH_WORKFLOW_LABELS.map((l) => l.name));
    expect(toUpdate).toEqual([]);
  });

  test("no-ops when all workflow labels exist with correct metadata", () => {
    const existing = RALPH_WORKFLOW_LABELS.map((label) => ({
      name: label.name.toUpperCase(),
      color: `#${label.color.toLowerCase()}`,
      description: ` ${label.description} `,
    }));
    const { toCreate, toUpdate } = computeRalphLabelSync(existing);
    expect(toCreate).toEqual([]);
    expect(toUpdate).toEqual([]);
  });

  test("creates missing labels and updates mismatched metadata", () => {
    const existing = [
      { name: "ralph:status:queued", color: "FFFFFF", description: "Queued" },
      { name: "ralph:status:in-progress", color: "FBCA04", description: "Ralph is actively working" },
    ];
    const { toCreate, toUpdate } = computeRalphLabelSync(existing);
    expect(toCreate.map((l) => l.name)).toEqual(
      RALPH_WORKFLOW_LABELS.map((l) => l.name).filter(
        (name) => name !== "ralph:status:queued" && name !== "ralph:status:in-progress"
      )
    );
    expect(toUpdate).toEqual([
      {
        currentName: "ralph:status:queued",
        patch: {
          color: "0366D6",
          description: "In queue; claimable",
        },
      },
    ]);
  });

  test("updates color without changing matching descriptions", () => {
    const existing = [
      { name: "ralph:status:queued", color: "0366D6", description: "In queue; claimable" },
      { name: "ralph:status:in-progress", color: "FBCA04", description: "Ralph is actively working" },
      { name: "ralph:status:in-bot", color: "0E8A16", description: "Task PR merged to bot/integration" },
      { name: "ralph:status:blocked", color: "000000", description: "Waiting on dependencies or human input" },
      { name: "ralph:status:done", color: "1A7F37", description: "Task merged to default branch" },
    ];
    const { toUpdate } = computeRalphLabelSync(existing);
    expect(toUpdate).toEqual([
      {
        currentName: "ralph:status:blocked",
        patch: { color: "D73A4A" },
      },
    ]);
  });

  test("uses current label casing when updating", () => {
    const existing = [
      { name: "Ralph:Status:Queued", color: "0366D6", description: "Queued" },
      { name: "ralph:status:in-progress", color: "FBCA04", description: "Ralph is actively working" },
      { name: "ralph:status:in-bot", color: "0E8A16", description: "Task PR merged to bot/integration" },
      { name: "ralph:status:blocked", color: "D73A4A", description: "Waiting on dependencies or human input" },
      { name: "ralph:status:done", color: "1A7F37", description: "Task merged to default branch" },
    ];
    const { toUpdate } = computeRalphLabelSync(existing);
    expect(toUpdate).toEqual([
      {
        currentName: "Ralph:Status:Queued",
        patch: { description: "In queue; claimable" },
      },
    ]);
  });

  test("ignores non-ralph labels and unknown ralph labels", () => {
    const existing = [
      { name: "dx", color: "1D76DB", description: "Developer experience" },
      { name: "ralph:unknown", color: "FFFFFF", description: "Extra" },
    ];
    const { toCreate, toUpdate } = computeRalphLabelSync(existing);
    expect(toUpdate).toEqual([]);
    expect(toCreate.map((l) => l.name)).toEqual(RALPH_WORKFLOW_LABELS.map((l) => l.name));
  });

  test("prefers the canonical-cased label when duplicates exist", () => {
    const existing = [
      { name: "Ralph:Status:Queued", color: "0366D6", description: "Queued" },
      { name: "ralph:status:queued", color: "0366D6", description: "In queue; claimable" },
      { name: "ralph:status:in-progress", color: "FBCA04", description: "Ralph is actively working" },
      { name: "ralph:status:in-bot", color: "0E8A16", description: "Task PR merged to bot/integration" },
      { name: "ralph:status:blocked", color: "D73A4A", description: "Waiting on dependencies or human input" },
      { name: "ralph:status:done", color: "1A7F37", description: "Task merged to default branch" },
    ];
    const { toUpdate } = computeRalphLabelSync(existing);
    expect(toUpdate).toEqual([]);
  });

  test("treats null description as empty string", () => {
    const existing = [
      { name: "ralph:status:queued", color: "0366D6", description: null },
      { name: "ralph:status:in-progress", color: "FBCA04", description: "Ralph is actively working" },
      { name: "ralph:status:in-bot", color: "0E8A16", description: "Task PR merged to bot/integration" },
      { name: "ralph:status:blocked", color: "D73A4A", description: "Waiting on dependencies or human input" },
      { name: "ralph:status:done", color: "1A7F37", description: "Task merged to default branch" },
    ];
    const { toUpdate } = computeRalphLabelSync(existing);
    expect(toUpdate).toEqual([
      {
        currentName: "ralph:status:queued",
        patch: { description: "In queue; claimable" },
      },
    ]);
  });

  test("includes paused status label", () => {
    const paused = RALPH_WORKFLOW_LABELS.find((label) => label.name === "ralph:status:paused");
    expect(paused?.description).toBe("Operator pause; do not claim or resume");
  });
});
