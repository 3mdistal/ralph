import { describe, expect, test } from "bun:test";

import { planRalphPriorityLabelSet } from "../queue/priority";

describe("planRalphPriorityLabelSet", () => {
  test("plans only canonical priority label mutations", () => {
    const plan = planRalphPriorityLabelSet("ralph:priority:p2");
    expect(plan.add).toEqual(["ralph:priority:p2"]);
    expect(plan.remove).toEqual(["ralph:priority:p0", "ralph:priority:p1", "ralph:priority:p3", "ralph:priority:p4"]);
    for (const label of [...plan.add, ...plan.remove]) {
      expect(label.startsWith("ralph:priority:")).toBe(true);
    }
  });
});
