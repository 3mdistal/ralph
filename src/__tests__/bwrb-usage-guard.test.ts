import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";

const BWRB_COMMAND_REGEX = /`bwrb\s/g;
const ROOT = process.cwd();
const SRC_ROOT = join(ROOT, "src");
const ALLOWED_BWRB_FILES = new Set([
  "src/bwrb/artifacts.ts",
  "src/escalation-notes.ts",
  "src/queue.ts",
]);

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

describe("bwrb usage guardrail", () => {
  test("bwrb CLI usage stays within the allowlist", async () => {
    const files = await listTypeScriptFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const matches = content.match(BWRB_COMMAND_REGEX);
      if (!matches) continue;

      const rel = relative(ROOT, file);
      if (!ALLOWED_BWRB_FILES.has(rel)) {
        offenders.push(rel);
      }
    }

    expect(offenders, `Unexpected bwrb CLI usage in: ${offenders.join(", ")}`).toEqual([]);
  });
});
