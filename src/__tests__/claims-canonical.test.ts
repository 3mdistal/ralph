import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_KEYS = [
  "schemaVersion",
  "domain",
  "id",
  "surface",
  "path",
  "claim",
  "status",
  "source",
] as const;

describe("claims/canonical.jsonl", () => {
  test("parses with unique ids and required keys", () => {
    const filePath = resolve(process.cwd(), "claims/canonical.jsonl");
    const contents = readFileSync(filePath, "utf8");
    const lines = contents
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0);

    const seen = new Set<string>();

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const key of REQUIRED_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(parsed, key)).toBe(true);
      }

      const id = String(parsed.id ?? "");
      expect(id.length).toBeGreaterThan(0);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
