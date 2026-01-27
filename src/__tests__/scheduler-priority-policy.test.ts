import { describe, expect, test } from "bun:test";

import {
  createPrioritySelectorState,
  selectNextRepoPriority,
  type PriorityRepo,
} from "../scheduler/priority-policy";

function runSelections(repos: PriorityRepo[], count: number): string[] {
  const selections: string[] = [];
  let state = createPrioritySelectorState();

  for (let i = 0; i < count; i++) {
    const result = selectNextRepoPriority(repos, state);
    state = result.state;
    if (!result.selectedRepo) break;
    selections.push(result.selectedRepo);
  }

  return selections;
}

describe("priority scheduler policy", () => {
  test("weights higher priority bands with extra selections", () => {
    const repos: PriorityRepo[] = [
      { name: "high", priority: 2 },
      { name: "low", priority: 0 },
    ];

    const selections = runSelections(repos, 4);
    expect(selections).toEqual(["high", "high", "high", "low"]);
  });

  test("round-robins within a band", () => {
    const repos: PriorityRepo[] = [
      { name: "a", priority: 1 },
      { name: "b", priority: 1 },
    ];

    const selections = runSelections(repos, 4);
    expect(selections).toEqual(["a", "b", "a", "b"]);
  });

  test("no starvation across bands within a cycle", () => {
    const repos: PriorityRepo[] = [
      { name: "alpha", priority: 3 },
      { name: "beta", priority: 0 },
    ];

    const selections = runSelections(repos, 5);
    expect(selections).toContain("beta");
  });

  test("resets state when priorities change", () => {
    const repos: PriorityRepo[] = [
      { name: "repo-a", priority: 2 },
      { name: "repo-b", priority: 0 },
    ];

    let state = createPrioritySelectorState();
    const first = selectNextRepoPriority(repos, state);
    state = first.state;
    expect(first.selectedRepo).toBe("repo-a");

    const updated: PriorityRepo[] = [
      { name: "repo-a", priority: 0 },
      { name: "repo-b", priority: 2 },
    ];

    const second = selectNextRepoPriority(updated, state);
    expect(second.selectedRepo).toBe("repo-b");
  });
});
