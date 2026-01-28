import { describe, expect, test } from "bun:test";
import { parseSeedManifest } from "../sandbox/seed-manifest";

const validManifest = {
  version: "v1",
  seedLabel: "ralph:seed-suite",
  marker: "ralph-seed-suite:v1",
  scenarios: [
    {
      slug: "example",
      title: "Example",
      body: {
        intro: "hello",
        blockedBy: [{ slug: "dep" }],
        taskList: [{ text: "task" }],
      },
    },
    { slug: "dep", title: "Dep" },
  ],
};

describe("seed manifest parsing", () => {
  test("accepts valid manifest", () => {
    const parsed = parseSeedManifest(JSON.stringify(validManifest));
    expect(parsed.version).toBe("v1");
    expect(parsed.scenarios.length).toBe(2);
  });

  test("rejects missing scenarios", () => {
    expect(() =>
      parseSeedManifest(JSON.stringify({ version: "v1", seedLabel: "x", marker: "m" }))
    ).toThrow(/scenarios must be a non-empty array/i);
  });
});
