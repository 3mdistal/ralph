import { describe, expect, test } from "bun:test";
import { appendBwrbNoteBody, buildIdeaPayload, createBwrbNote } from "../bwrb/artifacts";

type MockCall =
  | { kind: "resolve"; stdout: string }
  | { kind: "reject"; message?: string; stdout?: string };

function createMockBwrbRunner(calls: MockCall[]) {
  let index = 0;
  const payloads: string[] = [];

  const runner = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const json = String(values[values.length - 1] ?? "");
    payloads.push(json);

    const entry = calls[index++];
    const process = {
      cwd: () => process,
      quiet: async () => {
        if (!entry) throw new Error("Unexpected bwrb call");
        if (entry.kind === "resolve") return { stdout: entry.stdout };
        const err: any = new Error(entry.message ?? "bwrb error");
        if (entry.stdout) err.stdout = entry.stdout;
        throw err;
      },
    };

    return process;
  }) as any;

  return { runner, payloads };
}

describe("bwrb artifacts", () => {
  test("buildIdeaPayload mirrors inputs", () => {
    expect(buildIdeaPayload({ name: "Demo", creationDate: "2026-01-01", scope: "builder" })).toEqual({
      name: "Demo",
      "creation-date": "2026-01-01",
      scope: "builder",
    });
  });

  test("createBwrbNote skips when vault is missing", async () => {
    const payload = buildIdeaPayload({ name: "Test", creationDate: "2026-01-01", scope: "builder" });
    const result = await createBwrbNote(
      { type: "idea", action: "create notification", payload },
      { getVaultForStorage: () => null }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.skipped).toBe(true);
    }
  });

  test("createBwrbNote retries with suffix on duplicate", async () => {
    const { runner, payloads } = createMockBwrbRunner([
      {
        kind: "reject",
        stdout: JSON.stringify({ success: false, error: "File already exists" }),
      },
      {
        kind: "resolve",
        stdout: JSON.stringify({ success: true, path: "orchestration/notifications/test.md" }),
      },
    ]);

    const payload = buildIdeaPayload({ name: "Test", creationDate: "2026-01-01", scope: "builder" });
    const result = await createBwrbNote(
      { type: "idea", action: "create notification", payload, allowDuplicateSuffix: true },
      { getVaultForStorage: () => "/vault", bwrb: runner }
    );

    expect(result.ok).toBe(true);
    expect(payloads.length).toBe(2);
    const first = JSON.parse(payloads[0] ?? "{}");
    const second = JSON.parse(payloads[1] ?? "{}");
    expect(second.name).toContain(first.name);
    expect(second.name).not.toBe(first.name);
  });

  test("appendBwrbNoteBody returns error on append failure", async () => {
    const result = await appendBwrbNoteBody(
      { notePath: "/tmp/notes/test.md", body: "hello" },
      { appendFile: async () => { throw new Error("boom"); } }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("boom");
    }
  });
});
