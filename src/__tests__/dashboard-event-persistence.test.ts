import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { RalphEventBus } from "../dashboard/event-bus";
import { buildRalphEvent, safeJsonStringifyRalphEvent } from "../dashboard/events";
import {
  bucketUtcDay,
  cleanupDashboardEventLogs,
  computeRetentionDeletions,
  installDashboardEventPersistence,
} from "../dashboard/event-persistence";
import { redactSensitiveText } from "../redaction";

describe("dashboard event persistence core", () => {
  test("buckets UTC days deterministically", () => {
    const now = Date.parse("2026-01-02T12:00:00.000Z");
    expect(bucketUtcDay("2026-01-01T23:59:59.999Z", now)).toBe("2026-01-01");
    expect(bucketUtcDay("2026-01-02T00:00:00.000Z", now)).toBe("2026-01-02");
  });

  test("retention math ignores non-matching files", () => {
    const files = ["2026-01-01.jsonl", "2026-01-02.jsonl", "2026-01-15.jsonl", "notes.txt"];
    const nowMs = Date.parse("2026-01-15T12:00:00.000Z");
    const deletions = computeRetentionDeletions({ files, retentionDays: 14, nowMs });
    expect(deletions).toEqual(["2026-01-01.jsonl"]);
  });

  test("redacts obvious secrets and home dir", () => {
    const home = tmpdir();
    const input = [
      `${home}/secrets/ghp_abcdefghijklmnopqrstuvwxyz1234`,
      "github_pat_abcdefghijklmnopqrstuvwxyz1234",
      "sk-abcdefghijklmnopqrstuvwxyz1234",
      "xoxb-1234567890-abcdef",
      "Authorization: Bearer abc.def.ghi",
    ].join("\n");
    const output = redactSensitiveText(input, { homeDir: home });
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
    expect(output).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz1234");
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
    expect(output).not.toContain("xoxb-1234567890-abcdef");
    expect(output).not.toContain("Bearer abc.def.ghi");
    expect(output).toContain("~");
  });

  test("safeJsonStringifyRalphEvent tolerates BigInt and circular data", () => {
    const payload: any = { count: BigInt(5) };
    payload.self = payload;
    const event = buildRalphEvent({
      type: "log.opencode.event",
      level: "info",
      data: { event: payload },
    });
    const json = safeJsonStringifyRalphEvent(event);
    expect(json).toContain("\"5\"");
    expect(json).toContain("[Circular]");
  });
});

describe("dashboard event persistence integration", () => {
  test("persists events as JSONL and flushes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-events-"));
    const bus = new RalphEventBus();
    const persistence = installDashboardEventPersistence({
      bus,
      retentionDays: 14,
      eventsDir: dir,
    });

    for (let i = 0; i < 3; i++) {
      bus.publish(
        buildRalphEvent({
          type: "log.ralph",
          level: "info",
          ts: "2026-01-20T10:00:00.000Z",
          data: { message: `event-${i}` },
        })
      );
    }

    const flushed = await persistence.flush({ timeoutMs: 2000 });
    expect(flushed.flushed).toBe(true);

    const logPath = join(dir, "2026-01-20.jsonl");
    const contents = await readFile(logPath, "utf8");
    const lines = contents.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(3);

    persistence.unsubscribe();
  });

  test("rotates across dates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-events-"));
    const bus = new RalphEventBus();
    const persistence = installDashboardEventPersistence({
      bus,
      retentionDays: 14,
      eventsDir: dir,
    });

    bus.publish(
      buildRalphEvent({
        type: "log.ralph",
        level: "info",
        ts: "2026-02-01T10:00:00.000Z",
        data: { message: "one" },
      })
    );
    bus.publish(
      buildRalphEvent({
        type: "log.ralph",
        level: "info",
        ts: "2026-02-02T10:00:00.000Z",
        data: { message: "two" },
      })
    );

    await persistence.flush({ timeoutMs: 2000 });

    const files = await readdir(dir);
    expect(files.sort()).toEqual(["2026-02-01.jsonl", "2026-02-02.jsonl"]);

    persistence.unsubscribe();
  });

  test("cleanup deletes files outside retention window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-events-"));
    await writeFile(join(dir, "2026-01-01.jsonl"), "old\n");
    await writeFile(join(dir, "2026-01-02.jsonl"), "keep\n");
    await writeFile(join(dir, "2026-01-03.jsonl"), "keep\n");
    await writeFile(join(dir, "notes.txt"), "ignore\n");

    await cleanupDashboardEventLogs({
      eventsDir: dir,
      retentionDays: 2,
      now: () => Date.parse("2026-01-03T12:00:00.000Z"),
    });

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["2026-01-02.jsonl", "2026-01-03.jsonl", "notes.txt"]);
  });

  test("flush timeout returns without hanging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-events-"));
    const bus = new RalphEventBus();
    let appendStarted = false;
    const appendLine = async () => {
      appendStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    };

    const persistence = installDashboardEventPersistence({
      bus,
      retentionDays: 14,
      eventsDir: dir,
      appendLine,
    });

    bus.publish(
      buildRalphEvent({
        type: "log.ralph",
        level: "info",
        ts: "2026-01-20T10:00:00.000Z",
        data: { message: "slow" },
      })
    );

    const flushed = await persistence.flush({ timeoutMs: 50 });
    expect(appendStarted).toBe(true);
    expect(flushed.flushed).toBe(false);

    persistence.unsubscribe();
  });
});
