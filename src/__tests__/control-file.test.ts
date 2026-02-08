import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { resolveControlFilePath } from "../drain";
import { updateControlFile } from "../control-file";

describe("control file", () => {
  let priorXdgStateHome: string | undefined;
  let priorHome: string | undefined;
  const tempDirs: string[] = [];

  beforeEach(() => {
    priorXdgStateHome = process.env.XDG_STATE_HOME;
    priorHome = process.env.HOME;
  });

  afterEach(() => {
    if (priorXdgStateHome !== undefined) process.env.XDG_STATE_HOME = priorXdgStateHome;
    else delete process.env.XDG_STATE_HOME;
    if (priorHome !== undefined) process.env.HOME = priorHome;
    else delete process.env.HOME;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("applies drain patch and clears on resume", () => {
    const base = mkdtempSync(join(tmpdir(), "ralph-control-"));
    tempDirs.push(base);
    process.env.XDG_STATE_HOME = base;
    process.env.HOME = base;

    updateControlFile({
      patch: {
        mode: "draining",
        pauseRequested: true,
        pauseAtCheckpoint: "pr_ready",
        drainTimeoutMs: 5_000,
      },
    });

    const controlPath = resolveControlFilePath();
    expect(controlPath).toBe(join(base, ".ralph", "control", "control.json"));
    const parsed = JSON.parse(readFileSync(controlPath, "utf8")) as Record<string, unknown>;
    expect(parsed.mode).toBe("draining");
    expect(parsed.pause_requested).toBe(true);
    expect(parsed.pause_at_checkpoint).toBe("pr_ready");
    expect(parsed.drain_timeout_ms).toBe(5000);

    updateControlFile({
      patch: {
        mode: "running",
        pauseRequested: null,
        pauseAtCheckpoint: null,
        drainTimeoutMs: null,
      },
    });

    const updated = JSON.parse(readFileSync(controlPath, "utf8")) as Record<string, unknown>;
    expect(updated.mode).toBe("running");
    expect(updated.pause_requested).toBeUndefined();
    expect(updated.pause_at_checkpoint).toBeUndefined();
    expect(updated.drain_timeout_ms).toBeUndefined();
  });
});
