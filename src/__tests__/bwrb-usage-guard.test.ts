import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";

const BWRB_COMMAND_REGEX = /`bwrb\s/g;
const ROOT = process.cwd();
const SRC_ROOT = join(ROOT, "src");

const ALLOWED_BWRB_COMMAND_COUNTS = new Map<string, number>([
  ["src/queue.ts", 4],
  ["src/notify.ts", 2],
  ["src/escalation-notes.ts", 2],
  ["src/worker.ts", 1],
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
  test("bwrb CLI usage stays within the legacy allowlist", async () => {
    const files = await listTypeScriptFiles(SRC_ROOT);
    const counts = new Map<string, number>();

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const matches = content.match(BWRB_COMMAND_REGEX);
      if (!matches) continue;

      const rel = relative(ROOT, file);
      if (rel.includes("src/__tests__/")) continue;
      counts.set(rel, matches.length);
    }

    for (const [file, count] of counts.entries()) {
      const allowedCount = ALLOWED_BWRB_COMMAND_COUNTS.get(file);
      expect(allowedCount, `Unexpected bwrb CLI usage in ${file}.`).toBeDefined();
      expect(count, `Unexpected bwrb CLI usage count in ${file}.`).toBe(allowedCount);
    }

    for (const [file, allowedCount] of ALLOWED_BWRB_COMMAND_COUNTS.entries()) {
      const actualCount = counts.get(file) ?? 0;
      expect(actualCount, `bwrb CLI usage count changed in ${file}.`).toBe(allowedCount);
    }
  });
});
