import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { readOpencodeUsageSnapshot } from "../opencode-usage";

async function writeMessage(opts: {
  root: string;
  session: string;
  file: string;
  providerID: string;
  role: string;
  created: string | number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}): Promise<void> {
  const dir = join(opts.root, opts.session);
  await mkdir(dir, { recursive: true });

  const msg = {
    providerID: opts.providerID,
    role: opts.role,
    time: { created: opts.created },
    tokens: {
      input: opts.tokens.input,
      output: opts.tokens.output,
      reasoning: opts.tokens.reasoning,
      cache: {
        read: opts.tokens.cacheRead ?? 0,
        write: opts.tokens.cacheWrite ?? 0,
      },
    },
  };

  await writeFile(join(dir, opts.file), JSON.stringify(msg), "utf8");
}

describe("opencode usage reader", () => {
  test("filters to openai assistant and sums dashboard tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-usage-"));

    const nowMs = Date.parse("2026-01-10T10:00:00.000Z");
    const reset5hMs = nowMs + 60_000;
    const reset7dMs = nowMs + 60_000;

    try {
      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_1.json",
        providerID: "openai",
        role: "assistant",
        created: "2026-01-10T09:59:00.000Z",
        tokens: { input: 10, output: 20, reasoning: 30, cacheRead: 100, cacheWrite: 200 },
      });

      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_2.json",
        providerID: "openai",
        role: "user",
        created: "2026-01-10T09:59:30.000Z",
        tokens: { input: 999, output: 999, reasoning: 999 },
      });

      await writeMessage({
        root,
        session: "ses_b",
        file: "msg_1.json",
        providerID: "anthropic",
        role: "assistant",
        created: "2026-01-10T09:59:40.000Z",
        tokens: { input: 999, output: 999, reasoning: 999 },
      });

      const snapshot = await readOpencodeUsageSnapshot({
        now: nowMs,
        resetAt5h: reset5hMs,
        resetAt7d: reset7dMs,
        messagesRootDir: root,
        cacheWeight: 0,
      });

      expect(snapshot.countedMessages).toBe(1);

      expect(snapshot.windows.rolling5h.messageCount).toBe(1);
      expect(snapshot.windows.rolling5h.tokens.dashboardTotal).toBe(60);
      expect(snapshot.windows.rolling5h.tokens.weightedTotal).toBe(60);
      expect(snapshot.windows.rolling5h.tokens.cacheRead).toBe(100);
      expect(snapshot.windows.rolling5h.tokens.cacheWrite).toBe(200);

      expect(snapshot.windows.rolling7d.messageCount).toBe(1);
      expect(snapshot.windows.rolling7d.tokens.dashboardTotal).toBe(60);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("includes message at window start boundary and excludes before", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-usage-"));

    const nowMs = Date.parse("2026-01-10T10:00:00.000Z");
    const reset5hMs = nowMs + 60_000;
    const start5hMs = reset5hMs - 5 * 60 * 60 * 1000;

    const reset7dMs = nowMs + 60_000;

    try {
      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_1.json",
        providerID: "openai",
        role: "assistant",
        created: start5hMs - 1,
        tokens: { input: 1, output: 0, reasoning: 0 },
      });

      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_2.json",
        providerID: "openai",
        role: "assistant",
        created: start5hMs,
        tokens: { input: 2, output: 0, reasoning: 0 },
      });

      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_3.json",
        providerID: "openai",
        role: "assistant",
        created: nowMs,
        tokens: { input: 3, output: 0, reasoning: 0 },
      });

      const snapshot = await readOpencodeUsageSnapshot({
        now: nowMs,
        resetAt5h: reset5hMs,
        resetAt7d: reset7dMs,
        messagesRootDir: root,
      });

      expect(snapshot.windows.rolling5h.messageCount).toBe(2);
      expect(snapshot.windows.rolling5h.tokens.dashboardTotal).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parses created timestamp as epoch seconds and milliseconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-usage-"));

    const nowMs = Date.parse("2026-01-10T10:00:00.000Z");
    const reset5hMs = nowMs + 60_000;
    const reset7dMs = nowMs + 60_000;

    const createdSeconds = Math.floor(Date.parse("2026-01-10T09:59:00.000Z") / 1000);
    const createdMs = Date.parse("2026-01-10T09:59:30.000Z");

    try {
      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_1.json",
        providerID: "openai",
        role: "assistant",
        created: createdSeconds,
        tokens: { input: 1, output: 1, reasoning: 1 },
      });

      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_2.json",
        providerID: "openai",
        role: "assistant",
        created: createdMs,
        tokens: { input: 2, output: 2, reasoning: 2 },
      });

      const snapshot = await readOpencodeUsageSnapshot({
        now: nowMs,
        resetAt5h: reset5hMs,
        resetAt7d: reset7dMs,
        messagesRootDir: root,
      });

      expect(snapshot.windows.rolling5h.messageCount).toBe(2);
      expect(snapshot.windows.rolling5h.tokens.dashboardTotal).toBe(9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applies cache weight when computing weighted total", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-usage-"));

    const nowMs = Date.parse("2026-01-10T10:00:00.000Z");
    const reset5hMs = nowMs + 60_000;
    const reset7dMs = nowMs + 60_000;

    try {
      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_1.json",
        providerID: "openai",
        role: "assistant",
        created: "2026-01-10T09:59:00.000Z",
        tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 5, cacheWrite: 7 },
      });

      const weighted = await readOpencodeUsageSnapshot({
        now: nowMs,
        resetAt5h: reset5hMs,
        resetAt7d: reset7dMs,
        messagesRootDir: root,
        cacheWeight: 1,
      });

      expect(weighted.windows.rolling5h.tokens.dashboardTotal).toBe(10);
      expect(weighted.windows.rolling5h.tokens.weightedTotal).toBe(22);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
