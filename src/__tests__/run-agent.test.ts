import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { Readable } from "stream";

import { runAgent } from "../session";

describe("runAgent", () => {
  test("spawns opencode run with agent and no command", async () => {
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

    await runAgent("/tmp", "ralph-plan", "hello", {}, { spawn: spawn as any });

    const argsList = spawnedArgs ?? [];
    const first = argsList[0] ?? "";
    const argsText = argsList.join(" ");

    expect(argsList.length).toBeGreaterThan(0);

    expect(first).toBe("run");
    expect(argsText).toContain("--agent");
    expect(argsText).toContain("ralph-plan");
    expect(argsText).not.toContain("--command");
  });
});
