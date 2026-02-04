import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { Readable } from "stream";

import { runAgent } from "../session";

describe("runAgent", () => {
  test("spawns opencode run with agent and no command", async () => {
    const priorBin = process.env.OPENCODE_BIN;
    let spawnedArgs: string[] | null = null;

    const spawn = (cmd: string, args: string[]) => {
      if (cmd !== "opencode") throw new Error(`Unexpected command: ${cmd}`);
      spawnedArgs = args;

      const emitter = new EventEmitter();
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const proc = Object.assign(emitter, {
        pid: 777,
        stdout,
        stderr,
        kill: () => {},
      });

      setTimeout(() => emitter.emit("close", 0), 0);

      return proc as any;
    };

    try {
      // Force a stable command name for this test.
      process.env.OPENCODE_BIN = "opencode";
      await runAgent("/tmp", "ralph-plan", "hello", {}, { spawn: spawn as any });
    } finally {
      if (priorBin === undefined) delete (process.env as any).OPENCODE_BIN;
      else process.env.OPENCODE_BIN = priorBin;
    }

    const argsList = spawnedArgs ?? [];
    const argsText = argsList.join(" ");

    expect(argsList.length).toBeGreaterThan(0);

    expect(argsText.startsWith("run")).toBe(true);
    expect(argsText).toContain("--agent");
    expect(argsText).toContain("ralph-plan");
    expect(argsText).not.toContain("--command");
  });
});
