import { $ } from "bun";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, isAbsolute, join } from "path";

export const RALPH_PLAN_RELATIVE_PATH = ".ralph/plan.md";

const RALPH_ARTIFACT_DIR = ".ralph";
const PLAN_FILENAME = "plan.md";

const DEFAULT_PLAN_TEMPLATE = [
  "# Plan",
  "",
  "- [ ] Capture the plan steps here.",
  "- [ ] Update this checklist as steps complete.",
  "",
].join("\n");

function getRalphPlanPath(worktreePath: string): string {
  return join(worktreePath, RALPH_ARTIFACT_DIR, PLAN_FILENAME);
}

function resolveExcludePath(worktreePath: string, rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : join(worktreePath, rawPath);
}

async function getGitExcludePath(worktreePath: string): Promise<string | null> {
  try {
    const result = await $`git -C ${worktreePath} rev-parse --git-path info/exclude`.quiet();
    const raw = result.stdout.toString().trim();
    if (!raw) return null;
    return resolveExcludePath(worktreePath, raw);
  } catch {
    return null;
  }
}

async function ensureExcludeEntry(excludePath: string, entry: string): Promise<void> {
  await mkdir(dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }

  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry)) return;

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  const prefix = needsNewline ? "\n" : "";
  await appendFile(excludePath, `${prefix}${entry}\n`, "utf8");
}

export async function ensureRalphWorktreeArtifacts(worktreePath: string): Promise<{ planPath: string }> {
  const artifactsDir = join(worktreePath, RALPH_ARTIFACT_DIR);
  await mkdir(artifactsDir, { recursive: true });

  const planPath = getRalphPlanPath(worktreePath);
  if (!existsSync(planPath)) {
    await writeFile(planPath, DEFAULT_PLAN_TEMPLATE, "utf8");
  }

  const excludePath = await getGitExcludePath(worktreePath);
  if (excludePath) {
    await ensureExcludeEntry(excludePath, `${RALPH_ARTIFACT_DIR}/`);
  }

  return { planPath };
}
