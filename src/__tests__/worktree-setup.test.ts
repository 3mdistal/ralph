import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { computeLockfileSignature, runWorktreeSetup } from "../worktree-setup";

let worktreePath: string;

async function writeLockfile(name: string, contents: string | Uint8Array): Promise<void> {
  await writeFile(join(worktreePath, name), contents);
}

describe("worktree setup", () => {
  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), "ralph-setup-"));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  test("lockfile signature is deterministic", async () => {
    await writeLockfile("package-lock.json", "{\"name\":\"demo\"}");
    await writeLockfile("pnpm-lock.yaml", "lockfileVersion: 6");

    const first = await computeLockfileSignature(worktreePath);
    const second = await computeLockfileSignature(worktreePath);

    expect(first.signature).toBe(second.signature);
    expect(first.lockfiles.sort()).toEqual(["package-lock.json", "pnpm-lock.yaml"].sort());
  });

  test("setup run writes marker and then skips", async () => {
    await writeLockfile("package-lock.json", "{\"name\":\"demo\"}");

    const first = await runWorktreeSetup({
      worktreePath,
      commands: ["echo ok"],
    });
    expect(first.status).toBe("success");

    const markerPath = join(worktreePath, ".ralph", "setup-state.json");
    const marker = await readFile(markerPath, "utf8");
    expect(marker).toContain("commandsHash");

    const second = await runWorktreeSetup({
      worktreePath,
      commands: ["echo ok"],
    });
    expect(second.status).toBe("skipped");
  });

  test("setup failure returns structured failure", async () => {
    const result = await runWorktreeSetup({
      worktreePath,
      commands: ["exit 1"],
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain("Setup command failed");
    }
  });
});
