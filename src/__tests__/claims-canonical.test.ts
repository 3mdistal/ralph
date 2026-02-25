import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildClaimsSchemaValidator, validateAndCanonicalizeClaimsJsonl } from "../claims";

function readText(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function readAllowedDomains(): ReadonlySet<string> {
  const raw = JSON.parse(readText("claims/domains.json")) as {
    domains?: Array<{ id?: unknown }>;
  };
  return new Set(
    (raw.domains ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

describe("claims/canonical.jsonl", () => {
  test("canonical and example files validate against schema", () => {
    const schema = JSON.parse(readText("claims/schema.v1.json")) as unknown;
    const validateSchema = buildClaimsSchemaValidator(schema);
    const allowedDomains = readAllowedDomains();

    for (const file of ["claims/canonical.jsonl", "claims/examples.v1.jsonl"]) {
      const text = readText(file);
      const result = validateAndCanonicalizeClaimsJsonl(text, {
        validateSchema,
        allowedDomains,
      });

      expect(result.issues).toEqual([]);
      expect(result.claims.length).toBeGreaterThan(0);
    }
  });

  test("canonical file is already idempotently canonicalized", () => {
    const schema = JSON.parse(readText("claims/schema.v1.json")) as unknown;
    const validateSchema = buildClaimsSchemaValidator(schema);
    const allowedDomains = readAllowedDomains();
    const raw = readText("claims/canonical.jsonl");
    const result = validateAndCanonicalizeClaimsJsonl(raw, {
      validateSchema,
      allowedDomains,
    });

    expect(result.issues).toEqual([]);
    expect(result.canonicalText).toBe(normalizeNewlines(raw));
  });

  test("all canonical claim domains are allowlisted", () => {
    const allowedDomains = readAllowedDomains();
    const lines = readText("claims/canonical.jsonl")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const unknown = new Set<string>();

    for (const line of lines) {
      const parsed = JSON.parse(line) as { domain?: unknown };
      if (typeof parsed.domain !== "string") continue;
      if (!allowedDomains.has(parsed.domain)) unknown.add(parsed.domain);
    }

    expect(Array.from(unknown)).toEqual([]);
  });
});
