import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";

import { runAgent } from "../session";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete (process.env as any)[name];
  else process.env[name] = value;
}

describe("OpenCode GitHub scoping", () => {
  test("injects GH_TOKEN and non-interactive git auth into OpenCode env", async () => {
    const priorGh = process.env.GH_TOKEN;
    const priorGithub = process.env.GITHUB_TOKEN;
    const priorBin = process.env.OPENCODE_BIN;

    const cacheRoot = await mkdtemp(join(tmpdir(), "ralph-opencode-gh-scope-"));

    try {
      process.env.GH_TOKEN = "gho_testtoken123456789012345";
      process.env.GITHUB_TOKEN = "";
      process.env.OPENCODE_BIN = "/tmp/opencode-test-bin";

      let spawnedEnv: Record<string, string | undefined> | null = null;
      let spawnedCmd: string | null = null;

      const spawn = (cmd: string, _args: string[], opts: any) => {
        spawnedEnv = opts?.env ?? null;
        spawnedCmd = cmd;

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

      await runAgent(
        "/tmp",
        "ralph-plan",
        "hello",
        {
          repo: "3mdistal/ralph",
          cacheKey: "gh-scope-test",
          opencodeXdg: {
            cacheHome: cacheRoot,
          },
        },
        {
          spawn: spawn as any,
          resolveGhTokenEnv: async () => process.env.GH_TOKEN ?? null,
        }
      );

      const env: Record<string, string | undefined> = spawnedEnv ?? {};
      const xdgCacheHome = env["XDG_CACHE_HOME"] ?? "";

      if (spawnedCmd === null) throw new Error("spawn was not called");
      expect(String(spawnedCmd)).toBe("/tmp/opencode-test-bin");

      expect(xdgCacheHome).toContain(cacheRoot);
      expect(env["GH_CONFIG_DIR"]).toBe(join(xdgCacheHome, "gh"));
      expect(env["GH_PROMPT_DISABLED"]).toBe("1");
      expect(typeof env["GH_TOKEN"]).toBe("string");
      expect(env["GH_TOKEN"]?.trim()).toBeTruthy();
      expect(env["GITHUB_TOKEN"]).toBe(env["GH_TOKEN"]);

      expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
      expect(env["GIT_ASKPASS"]).toBe(join(xdgCacheHome, "git-askpass.sh"));
    } finally {
      restoreEnvVar("GH_TOKEN", priorGh);
      restoreEnvVar("GITHUB_TOKEN", priorGithub);
      restoreEnvVar("OPENCODE_BIN", priorBin);
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
