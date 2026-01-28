import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { runAgent } from "../session";

describe("session event callbacks", () => {
  test("invokes onEvent for parsed JSON lines", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "ralph-session-"));
    const events: any[] = [];

    const spawn = () => {
      const proc = new EventEmitter() as any;
      const stdout = new EventEmitter() as any;
      const stderr = new EventEmitter() as any;
      stdout.resume = () => {};
      stderr.resume = () => {};
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.pid = 1234;

      setTimeout(() => {
        stdout.emit(
          "data",
          Buffer.from('{"type":"text","part":{"text":"hello"},"sessionId":"ses_test"}\n')
        );
        proc.emit("close", 0);
      }, 0);

      return proc;
    };

    await runAgent(
      "/tmp",
      "planner",
      "hello",
      {
        onEvent: (event) => events.push(event),
      },
      { spawn, sessionsDir }
    );

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("text");
  });
});
