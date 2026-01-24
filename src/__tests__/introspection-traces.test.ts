import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { cleanupSessionArtifacts } from "../introspection-traces";

describe("introspection trace cleanup", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "ralph-sessions-"));
    process.env.RALPH_SESSIONS_DIR = sessionsDir;
  });

  afterEach(async () => {
    delete process.env.RALPH_SESSIONS_DIR;
    await rm(sessionsDir, { recursive: true, force: true });
  });

  test("preserves events.jsonl and removes other artifacts", async () => {
    const sessionId = "ses_keep";
    const sessionDir = join(sessionsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "events.jsonl"), "{\"type\":\"run\"}\n");
    await writeFile(join(sessionDir, "summary.json"), "summary");
    await mkdir(join(sessionDir, "nested"), { recursive: true });
    await writeFile(join(sessionDir, "nested", "temp.txt"), "temp");

    await cleanupSessionArtifacts(sessionId);

    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
    expect(existsSync(join(sessionDir, "summary.json"))).toBe(false);
    expect(existsSync(join(sessionDir, "nested"))).toBe(false);
  });

  test("removes session dir when events.jsonl is missing", async () => {
    const sessionId = "ses_remove";
    const sessionDir = join(sessionsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "summary.json"), "summary");

    await cleanupSessionArtifacts(sessionId);

    expect(existsSync(sessionDir)).toBe(false);
  });

  test("skips cleanup for unsafe session ids", async () => {
    const sentinel = join(sessionsDir, "sentinel.txt");
    await writeFile(sentinel, "keep");

    const unsafeIds = ["../unsafe", ".", "..", "ses bad"];
    for (const unsafeId of unsafeIds) {
      await cleanupSessionArtifacts(unsafeId);
    }

    expect(existsSync(sentinel)).toBe(true);
  });
});
