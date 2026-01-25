import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { getRalphConfigTomlPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeToml(lines: string[]): Promise<void> {
  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(getRalphConfigTomlPath(), lines.join("\n"), "utf8");
}

async function loadRepoLimit(query: string, repo = "demo/repo"): Promise<number> {
  const cfgMod = await import(`../config?${query}`);
  cfgMod.__resetConfigForTests();
  cfgMod.loadConfig();
  return cfgMod.getRepoMaxWorkers(repo);
}

describe("repo concurrency slots config", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    releaseLock?.();
    releaseLock = null;
  });

  test("uses concurrencySlots when configured", async () => {
    await writeToml([
      "repos = [{ name = \"demo/repo\", concurrencySlots = 3 }]",
    ]);

    const limit = await loadRepoLimit("repo-concurrency-slots");
    expect(limit).toBe(3);
  });

  test("falls back to maxWorkers when concurrencySlots missing", async () => {
    await writeToml([
      "repos = [{ name = \"demo/repo\", maxWorkers = 2 }]",
    ]);

    const limit = await loadRepoLimit("repo-concurrency-max-workers");
    expect(limit).toBe(2);
  });

  test("concurrencySlots wins when both set", async () => {
    await writeToml([
      "repos = [{ name = \"demo/repo\", concurrencySlots = 4, maxWorkers = 2 }]",
    ]);

    const limit = await loadRepoLimit("repo-concurrency-both");
    expect(limit).toBe(4);
  });
});
