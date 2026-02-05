import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import {
  createRalphRun,
  ensureRalphRunGateRows,
  getRalphRunGateState,
  initStateDb,
} from "../state";
import { runPreflightGate } from "../gates/preflight";

let homeDir: string;
let worktreeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

describe("preflight gate", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    worktreeDir = await mkdtemp(join(tmpdir(), "ralph-worktree-"));
    await mkdir(worktreeDir, { recursive: true });
    process.env.HOME = homeDir;
    initStateDb();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("records pass", async () => {
    const runId = createRalphRun({ repo: "demo/repo", issue: "demo/repo#1", taskPath: "tasks/1", attemptKind: "process" });
    ensureRalphRunGateRows({ runId });

    const result = await runPreflightGate({
      runId,
      worktreePath: worktreeDir,
      commands: ["echo preflight-ok"],
    });

    expect(result.status).toBe("pass");
    const state = getRalphRunGateState(runId);
    const preflight = state.results.find((r) => r.gate === "preflight");
    expect(preflight?.status).toBe("pass");
    expect(preflight?.command).toContain("echo preflight-ok");
    expect(state.artifacts.some((a) => a.gate === "preflight" && a.kind === "command_output")).toBe(true);
  });

  test("records fail", async () => {
    const runId = createRalphRun({ repo: "demo/repo", issue: "demo/repo#2", taskPath: "tasks/2", attemptKind: "process" });
    ensureRalphRunGateRows({ runId });

    const result = await runPreflightGate({
      runId,
      worktreePath: worktreeDir,
      commands: ["exit 1"],
    });

    expect(result.status).toBe("fail");
    const state = getRalphRunGateState(runId);
    const preflight = state.results.find((r) => r.gate === "preflight");
    expect(preflight?.status).toBe("fail");
    expect(state.artifacts.some((a) => a.gate === "preflight" && a.kind === "failure_excerpt")).toBe(true);
  });

  test("records skipped", async () => {
    const runId = createRalphRun({ repo: "demo/repo", issue: "demo/repo#3", taskPath: "tasks/3", attemptKind: "process" });
    ensureRalphRunGateRows({ runId });

    const result = await runPreflightGate({
      runId,
      worktreePath: worktreeDir,
      commands: [],
      skipReason: "no preflight configured",
    });

    expect(result.status).toBe("skipped");
    const state = getRalphRunGateState(runId);
    const preflight = state.results.find((r) => r.gate === "preflight");
    expect(preflight?.status).toBe("skipped");
    expect(preflight?.skipReason).toBe("no preflight configured");
  });
});
