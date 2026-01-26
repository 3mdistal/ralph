import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { readOpencodeSessionTokenTotals, readOpencodeSessionTokenTotalsWithQuality } from "../opencode-session-tokens";

async function writeMessage(opts: {
  root: string;
  session: string;
  file: string;
  providerID?: string;
  role?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}): Promise<void> {
  const dir = join(opts.root, opts.session);
  await mkdir(dir, { recursive: true });

  const msg: Record<string, unknown> = {};
  if (opts.providerID !== undefined) msg.providerID = opts.providerID;
  if (opts.role !== undefined) msg.role = opts.role;
  if (opts.tokens) {
    msg.tokens = {
      input: opts.tokens.input,
      output: opts.tokens.output,
      reasoning: opts.tokens.reasoning,
      cache: {
        read: opts.tokens.cacheRead,
        write: opts.tokens.cacheWrite,
      },
    };
  }

  await writeFile(join(dir, opts.file), JSON.stringify(msg), "utf8");
}

describe("opencode session token totals", () => {
  test("sums assistant tokens and cache when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-session-"));

    try {
      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_1.json",
        providerID: "openai",
        role: "assistant",
        tokens: { input: 10, output: 20, reasoning: 30, cacheRead: 5, cacheWrite: 7 },
      });

      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_2.json",
        providerID: "openai",
        role: "user",
        tokens: { input: 999, output: 999, reasoning: 999 },
      });

      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_3.json",
        providerID: "anthropic",
        role: "assistant",
        tokens: { input: 999, output: 999, reasoning: 999 },
      });

      await writeMessage({
        root,
        session: "ses_a",
        file: "msg_4.json",
        role: "assistant",
        tokens: { input: 2, output: 2, reasoning: 2 },
      });

      const totals = await readOpencodeSessionTokenTotals({
        sessionId: "ses_a",
        messagesRootDir: root,
        providerID: "openai",
        includeCache: true,
      });

      expect(totals).toEqual({ input: 12, output: 22, reasoning: 32, total: 66, cacheRead: 5, cacheWrite: 7 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips malformed JSON and missing token fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-session-"));

    try {
      await writeMessage({
        root,
        session: "ses_b",
        file: "msg_1.json",
        providerID: "openai",
        role: "assistant",
        tokens: { input: 3, output: 1, reasoning: 1 },
      });

      const dir = join(root, "ses_b");
      await writeFile(join(dir, "msg_2.json"), "{", "utf8");
      await writeMessage({
        root,
        session: "ses_b",
        file: "msg_3.json",
        providerID: "openai",
        role: "assistant",
      });

      await writeMessage({
        root,
        session: "ses_b",
        file: "msg_4.json",
        providerID: "openai",
        tokens: { input: 1, output: 1, reasoning: 1 },
      });

      const totals = await readOpencodeSessionTokenTotals({ sessionId: "ses_b", messagesRootDir: root });

      expect(totals).toEqual({ input: 4, output: 2, reasoning: 2, total: 8 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("missing session directory returns zeros", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-session-"));

    try {
      const totals = await readOpencodeSessionTokenTotals({ sessionId: "ses_missing", messagesRootDir: root });

      expect(totals).toEqual({ input: 0, output: 0, reasoning: 0, total: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid session ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-session-"));

    try {
      await writeMessage({
        root,
        session: "ses_safe",
        file: "msg_1.json",
        providerID: "openai",
        role: "assistant",
        tokens: { input: 4, output: 0, reasoning: 0 },
      });

      const totals = await readOpencodeSessionTokenTotals({
        sessionId: "../ses_safe",
        messagesRootDir: root,
      });

      expect(totals).toEqual({ input: 0, output: 0, reasoning: 0, total: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports missing quality for absent or empty sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-opencode-session-"));

    try {
      const missing = await readOpencodeSessionTokenTotalsWithQuality({ sessionId: "ses_missing", messagesRootDir: root });
      expect(missing.quality).toBe("missing");

      await mkdir(join(root, "ses_empty"), { recursive: true });
      const empty = await readOpencodeSessionTokenTotalsWithQuality({ sessionId: "ses_empty", messagesRootDir: root });
      expect(empty.quality).toBe("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
