import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { createGhRunner, GhDeferredError } from "../github/gh-runner";
import {
  __resetGitHubGovernorForTests,
  __setGitHubGovernorCooldownForTests,
  decideGitHubBudget,
} from "../github/budget-governor";
import { closeStateDbForTests } from "../state";

describe("github budget governor", () => {
  let priorGovernor: string | undefined;
  let priorDryRun: string | undefined;
  let priorHome: string | undefined;
  let priorStateDbPath: string | undefined;
  let priorDollar: unknown;
  let homeDir: string;

  beforeEach(async () => {
    priorGovernor = process.env.RALPH_GITHUB_BUDGET_GOVERNOR;
    priorDryRun = process.env.RALPH_GITHUB_BUDGET_GOVERNOR_DRY_RUN;
    priorHome = process.env.HOME;
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    priorDollar = (globalThis as any).$;

    homeDir = await mkdtemp(join(tmpdir(), "ralph-governor-home-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, ".ralph", "state.sqlite");
    process.env.RALPH_GITHUB_BUDGET_GOVERNOR = "1";
    process.env.RALPH_GITHUB_BUDGET_GOVERNOR_DRY_RUN = "0";

    closeStateDbForTests();
    __resetGitHubGovernorForTests();
  });

  afterEach(async () => {
    closeStateDbForTests();
    __resetGitHubGovernorForTests();

    if (priorGovernor === undefined) delete process.env.RALPH_GITHUB_BUDGET_GOVERNOR;
    else process.env.RALPH_GITHUB_BUDGET_GOVERNOR = priorGovernor;

    if (priorDryRun === undefined) delete process.env.RALPH_GITHUB_BUDGET_GOVERNOR_DRY_RUN;
    else process.env.RALPH_GITHUB_BUDGET_GOVERNOR_DRY_RUN = priorDryRun;

    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;

    if (priorStateDbPath === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDbPath;

    (globalThis as any).$ = priorDollar;
    await rm(homeDir, { recursive: true, force: true });
  });

  test("defers best-effort during cooldown but allows critical", () => {
    const now = Date.now();
    __setGitHubGovernorCooldownForTests("3mdistal/ralph", now + 60_000);

    const bestEffort = decideGitHubBudget({
      repo: "3mdistal/ralph",
      lane: "best_effort",
      isWrite: true,
      nowMs: now,
    });
    expect(bestEffort.kind).toBe("defer");

    const critical = decideGitHubBudget({
      repo: "3mdistal/ralph",
      lane: "critical",
      isWrite: true,
      nowMs: now,
    });
    expect(critical.kind).toBe("allow");
  });

  test("gh runner defers best-effort commands during cooldown", async () => {
    let executed = 0;
    (globalThis as any).$ = ((_: TemplateStringsArray, ...__values: unknown[]) => {
      const stub: any = {
        cwd: () => stub,
        quiet: async () => {
          executed += 1;
          return { stdout: "" };
        },
      };
      return stub;
    }) as any;

    __setGitHubGovernorCooldownForTests("3mdistal/ralph", Date.now() + 60_000);
    const ghRead = createGhRunner({ repo: "3mdistal/ralph", mode: "read", lane: "best_effort", source: "audit:sweep" });

    await expect(ghRead`gh api /repos/3mdistal/ralph`.quiet()).rejects.toBeInstanceOf(GhDeferredError);
    expect(executed).toBe(0);
  });
});
