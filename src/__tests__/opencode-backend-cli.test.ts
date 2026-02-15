import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { Readable } from "stream";

import { getDefaultOpenCodeBackend } from "../session";

describe("OpenCode CLI backend", () => {
  test("exposes Phase 0 capabilities with CLI read methods disabled", () => {
    const backend = getDefaultOpenCodeBackend();
    expect(backend.capabilities.ensureOrAttachServer).toBe(true);
    expect(backend.capabilities.createOrResumeSession).toBe(true);
    expect(backend.capabilities.sendStageMessage).toBe(true);
    expect(backend.capabilities.subscribeEvents).toBe(true);
    expect(backend.capabilities.abort).toBe(true);
    expect(backend.capabilities.fetchMessages).toBe(false);
    expect(backend.capabilities.fetchStatus).toBe(false);
    expect(backend.capabilities.fetchDiff).toBe(false);
  });

  test("routes continue-command runs through existing CLI behavior", async () => {
    const priorBin = process.env.OPENCODE_BIN;
    let spawnedArgs: string[] | null = null;

    const spawn = (cmd: string, args: string[]) => {
      if (cmd !== "opencode") throw new Error(`Unexpected command: ${cmd}`);
      spawnedArgs = args;

      const emitter = new EventEmitter();
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const proc = Object.assign(emitter, {
        pid: 888,
        stdout,
        stderr,
        kill: () => {},
      });

      setTimeout(() => emitter.emit("close", 0), 0);

      return proc as any;
    };

    try {
      process.env.OPENCODE_BIN = "opencode";
      await getDefaultOpenCodeBackend().run({
        kind: "continue-command",
        repoPath: "/tmp",
        sessionId: "ses_test",
        command: "survey",
        args: [],
        options: {},
        testOverrides: { spawn: spawn as any },
      });
    } finally {
      if (priorBin === undefined) delete (process.env as any).OPENCODE_BIN;
      else process.env.OPENCODE_BIN = priorBin;
    }

    const argsText = (spawnedArgs ?? []).join(" ");
    expect(argsText).toContain("run");
    expect(argsText).toContain("--command");
    expect(argsText).toContain("survey");
    expect(argsText).toContain("-s");
    expect(argsText).toContain("ses_test");
  });
});
