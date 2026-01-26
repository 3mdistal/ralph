import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  computeCommandsHash,
  computeDependencySignature,
  computeSetupPlan,
  ensureWorktreeSetup,
  readSetupState,
  writeSetupState,
} from "../worktree-setup";

let workdir: string;

describe("worktree setup", () => {
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "ralph-setup-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  test("computeCommandsHash normalizes whitespace", () => {
    const a = computeCommandsHash([" echo hi ", "ls -la"]);
    const b = computeCommandsHash(["echo hi", "ls -la"]);
    const c = computeCommandsHash(["echo hi", "ls"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("computeDependencySignature prefers lockfiles", async () => {
    await writeFile(join(workdir, "package.json"), "{}", "utf8");
    await writeFile(join(workdir, "bun.lockb"), Buffer.from([1, 2, 3]));

    const signature = await computeDependencySignature(workdir);
    expect(signature.source).toBe("lockfile");
    expect(signature.files).toContain("bun.lockb");
  });

  test("computeDependencySignature falls back to manifests", async () => {
    await writeFile(join(workdir, "package.json"), "{}", "utf8");

    const signature = await computeDependencySignature(workdir);
    expect(signature.source).toBe("manifest");
    expect(signature.files).toContain("package.json");
  });

  test("computeSetupPlan skips when marker matches", async () => {
    await mkdir(join(workdir, ".ralph"), { recursive: true });
    await writeFile(join(workdir, "bun.lockb"), Buffer.from([9, 9, 9]));

    const commands = ["bun install --frozen-lockfile"];
    const commandsHash = computeCommandsHash(commands);
    const signature = await computeDependencySignature(workdir);

    const markerPath = join(workdir, ".ralph", "setup-state.json");
    await writeSetupState(markerPath, {
      version: 1,
      commandsHash,
      lockfileSignature: signature.signature,
      completedAt: new Date().toISOString(),
    });

    const plan = await computeSetupPlan({ worktreePath: workdir, commands });
    expect(plan.action).toBe("skip");
  });

  test("writeSetupState/readSetupState round-trip", async () => {
    const markerPath = join(workdir, ".ralph", "setup-state.json");
    const state = {
      version: 1,
      commandsHash: "abc",
      lockfileSignature: "def",
      completedAt: new Date().toISOString(),
    };
    await writeSetupState(markerPath, state);
    const readBack = await readSetupState(markerPath);
    expect(readBack).toEqual(state);
  });

  test("ensureWorktreeSetup breaks stale locks", async () => {
    const ralphDir = join(workdir, ".ralph");
    const lockDir = join(ralphDir, "setup.lock.d");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "heartbeat"), String(Date.now() - 60_000), "utf8");
    await writeFile(join(lockDir, "owner.json"), "{}", "utf8");

    const result = await ensureWorktreeSetup({
      worktreePath: workdir,
      commands: ["true"],
      lockStaleMs: 10,
      lockWaitTimeoutMs: 200,
      perCommandTimeoutMs: 2000,
      totalTimeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
  });
});
