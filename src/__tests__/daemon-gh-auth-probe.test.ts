import { describe, expect, test } from "bun:test";

import type { RalphConfig } from "../config";
import { resolveDaemonAuthProbe, validateDaemonGhAuth } from "../github/daemon-auth-probe";

type RunnerProcess = {
  cwd: (path: string) => RunnerProcess;
  quiet: () => Promise<{ stdout: string }>;
};

function toCommand(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += String(values[i] ?? "");
    out += strings[i + 1] ?? "";
  }
  return out.trim();
}

function createConfig(overrides?: Partial<RalphConfig>): RalphConfig {
  return {
    repos: [],
    maxWorkers: 1,
    batchSize: 10,
    pollInterval: 30_000,
    doneReconcileIntervalMs: 300_000,
    labelReconcileIntervalMs: 300_000,
    ownershipTtlMs: 60_000,
    owner: "3mdistal",
    devDir: "/tmp",
    ...overrides,
  } as RalphConfig;
}

function createRunnerFrom(
  exec: (command: string) => Promise<{ stdout: string }>
): (repo: string) => (strings: TemplateStringsArray, ...values: unknown[]) => RunnerProcess {
  return () => {
    return (strings: TemplateStringsArray, ...values: unknown[]): RunnerProcess => {
      const command = toCommand(strings, values);
      const processLike: RunnerProcess = {
        cwd: () => processLike,
        quiet: async () => exec(command),
      };
      return processLike;
    };
  };
}

describe("daemon github auth probe", () => {
  test("uses repo-scoped probe when prod githubApp auth is configured", async () => {
    const config = createConfig({
      githubApp: {
        appId: 123,
        installationId: 456,
        privateKeyPath: "/tmp/key.pem",
      },
    });
    const commands: string[] = [];

    await validateDaemonGhAuth({
      config,
      probeRepo: "3mdistal/ralph",
      createRunner: createRunnerFrom(async (command) => {
        commands.push(command);
        return { stdout: "" };
      }),
    });

    expect(resolveDaemonAuthProbe(config, "3mdistal/ralph")).toEqual({
      kind: "repo",
      command: "gh api repos/3mdistal/ralph",
    });
    expect(commands).toEqual(["gh api repos/3mdistal/ralph"]);
  });

  test("invalid app auth still fails with clear diagnostics", async () => {
    const config = createConfig({
      githubApp: {
        appId: 123,
        installationId: 456,
        privateKeyPath: "/tmp/key.pem",
      },
    });

    let errorMessage = "";
    try {
      await validateDaemonGhAuth({
        config,
        probeRepo: "3mdistal/ralph",
        createRunner: createRunnerFrom(async (command) => {
          const error: any = new Error("Resource not accessible by integration (HTTP 403)");
          error.ghCommand = command;
          error.stderr = "HTTP 403";
          throw error;
        }),
      });
    } catch (error: any) {
      errorMessage = String(error?.message ?? "");
    }

    expect(errorMessage).toContain("[ralph] GitHub auth validation failed for gh CLI (daemon mode).");
    expect(errorMessage).toContain("Command: gh api repos/3mdistal/ralph");
    expect(errorMessage).toContain("Message: Resource not accessible by integration (HTTP 403)");
    expect(errorMessage).toContain("stderr: HTTP 403");
  });

  test("keeps /user probe for non-app token flow", async () => {
    const config = createConfig({ githubApp: undefined });
    const commands: string[] = [];

    await validateDaemonGhAuth({
      config,
      probeRepo: "3mdistal/ralph",
      createRunner: createRunnerFrom(async (command) => {
        commands.push(command);
        return { stdout: "" };
      }),
    });

    expect(resolveDaemonAuthProbe(config, "3mdistal/ralph")).toEqual({
      kind: "user",
      command: "gh api /user",
    });
    expect(commands).toEqual(["gh api /user"]);
  });
});
