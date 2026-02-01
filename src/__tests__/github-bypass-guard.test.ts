import { describe, expect, test } from "bun:test";

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const SRC_ROOT = join(process.cwd(), "src");

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      results.push(...(await listFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("github bypass guardrails", () => {
  test("no raw gh spawns outside gh-runner", async () => {
    const files = await listFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (/\$`gh\s/i.test(content)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("direct api.github.com usage is centralized", async () => {
    const allowlist = new Set([
      join(SRC_ROOT, "github", "client.ts"),
      join(SRC_ROOT, "github-app-auth.ts"),
      join(SRC_ROOT, "github", "issues-rest.ts"),
    ]);

    const files = await listFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      if (allowlist.has(file)) continue;
      const content = await readFile(file, "utf8");
      if (content.includes("api.github.com")) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
