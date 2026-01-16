import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { Readable } from "stream";

import { __resetOpencodeRunsForTests, registerOpencodeRun, terminateOpencodeRuns } from "../opencode-process-registry";
import { runCommand } from "../session";

describe("OpenCode shutdown handling", () => {
  beforeEach(() => {
    __resetOpencodeRunsForTests();
  });

  test("terminateOpencodeRuns targets process groups", async () => {
    const proc = { pid: 4321 } as any;
    registerOpencodeRun(proc, { useProcessGroup: true, command: "run" });

    const calls: Array<{ pid: number; signal: unknown }> = [];
    const processKill = (pid: number, signal?: unknown) => {
      calls.push({ pid, signal });
      if (signal === "SIGTERM" || signal === "SIGKILL" || signal === 0) return true;
      return true;
    };

    const result = await terminateOpencodeRuns({ graceMs: 0, processKill });

    expect(result.total).toBe(1);
    expect(calls[0]).toEqual({ pid: -4321, signal: "SIGTERM" });
    expect(calls[1]).toEqual({ pid: -4321, signal: 0 });
    expect(calls[2]).toEqual({ pid: -4321, signal: "SIGKILL" });
  });

  test("runCommand spawns detached process group on posix", async () => {
    if (process.platform === "win32") return;

    let spawnOptions: any = null;
    const spawn = () => {
      const emitter = new EventEmitter();
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const proc = Object.assign(emitter, {
        pid: 555,
        stdout,
        stderr,
        kill: () => {},
      });

      setTimeout(() => emitter.emit("close", 0), 0);

      return proc as any;
    };

    await runCommand("/tmp", "next-task", [], {}, { spawn: ((cmd: string, args: string[], options: any) => {
      spawnOptions = options;
      return spawn();
    }) as any });

    expect(spawnOptions?.detached).toBe(true);
  });
});
