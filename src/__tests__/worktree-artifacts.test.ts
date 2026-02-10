import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ensureRalphWorktreeArtifacts } from "../worktree-artifacts";

let repoDir: string;

describe("worktree artifacts", () => {
  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ralph-worktree-artifacts-"));
    await $`git init -q`.cwd(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("creates plan file and excludes .ralph directory", async () => {
    const { planPath } = await ensureRalphWorktreeArtifacts(repoDir);
    expect(planPath).toBe(join(repoDir, ".ralph", "plan.md"));

    const excludePath = join(repoDir, ".git", "info", "exclude");
    const excludeContents = await readFile(excludePath, "utf8");
    expect(excludeContents).toContain(".ralph/");

    const planContents = await readFile(planPath, "utf8");
    expect(planContents).toContain("# Plan");
  });

  test("marks tracked .ralph files as skip-worktree", async () => {
    await mkdir(join(repoDir, ".ralph"), { recursive: true });
    await writeFile(join(repoDir, ".ralph", "plan.md"), "# Plan\n\n- [ ] hi\n", "utf8");
    await $`git add .ralph/plan.md`.cwd(repoDir);

    await ensureRalphWorktreeArtifacts(repoDir);

    const result = await $`git ls-files -v -- .ralph/plan.md`.cwd(repoDir).quiet();
    const line = result.stdout.toString().trim();
    expect(line.startsWith("S ")).toBe(true);
  });
});
