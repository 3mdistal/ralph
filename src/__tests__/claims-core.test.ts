import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildClaimsSchemaValidator, parseAllowedDomains, validateAndCanonicalizeClaimsJsonl, type ClaimsSchemaValidator } from "../claims";

const alwaysValidSchema: ClaimsSchemaValidator = Object.assign(
  (_value: unknown): boolean => true,
  { errors: [] as const }
);

function readText(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function buildV1Validator(): ClaimsSchemaValidator {
  return buildClaimsSchemaValidator(JSON.parse(readText("claims/schema.v1.json")) as unknown);
}

function readAllowedDomains(): ReadonlySet<string> {
  return parseAllowedDomains(JSON.parse(readText("claims/domains.json")) as unknown);
}

describe("claims core failure contracts", () => {
  test("reports malformed JSON with line number", () => {
    const input = [
      '{"schemaVersion":1,"domain":"claims","id":"ok.one","surface":"filesystem","path":"a","claim":"ok","status":"planned","source":"claims/README.md"}',
      '{"schemaVersion":1,"domain":"claims",',
    ].join("\n");

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: alwaysValidSchema,
      allowedDomains: new Set(["claims"]),
    });

    expect(result.issues.length).toBe(1);
    expect(result.issues[0]?.code).toBe("E_PARSE_JSON");
    expect(result.issues[0]?.line).toBe(2);
  });

  test("reports duplicate ids with first and repeat line", () => {
    const input = [
      '{"schemaVersion":1,"domain":"claims","id":"dup.id","surface":"filesystem","path":"a","claim":"first","status":"planned","source":"claims/README.md"}',
      '{"schemaVersion":1,"domain":"claims","id":"dup.id","surface":"filesystem","path":"b","claim":"second","status":"planned","source":"claims/README.md"}',
    ].join("\n");

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: alwaysValidSchema,
      allowedDomains: new Set(["claims"]),
    });

    expect(result.issues.length).toBe(1);
    expect(result.issues[0]?.code).toBe("E_ID_DUPLICATE");
    expect(result.issues[0]?.line).toBe(2);
    expect(result.issues[0]?.message).toContain("line 1");
    expect(result.issues[0]?.message).toContain("line 2");
  });

  test("reports unknown domain with stable error code", () => {
    const input =
      '{"schemaVersion":1,"domain":"unknown","id":"x.id","surface":"filesystem","path":"a","claim":"x","status":"planned","source":"claims/README.md"}\n';

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: alwaysValidSchema,
      allowedDomains: new Set(["claims"]),
    });

    expect(result.issues.length).toBe(1);
    expect(result.issues[0]?.code).toBe("E_DOMAIN_UNKNOWN");
    expect(result.issues[0]?.line).toBe(1);
  });

  test("reports schema errors with path", () => {
    const input =
      '{"schemaVersion":1,"domain":"claims","id":"bad.id","surface":"filesystem","path":"a","claim":"x","status":"invalid","source":"claims/README.md"}\n';

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: readAllowedDomains(),
    });

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.code).toBe("E_SCHEMA");
    expect(result.issues[0]?.line).toBe(1);
    expect(result.issues[0]?.path).toBe("/status");
  });

  test("duplicate-id detection still applies when earlier line fails schema", () => {
    const input = [
      '{"schemaVersion":1,"domain":"claims","id":"dup.invalid","surface":"filesystem","path":"a","claim":"missing status","source":"claims/README.md"}',
      '{"schemaVersion":1,"domain":"claims","id":"dup.invalid","surface":"filesystem","path":"b","claim":"valid","status":"planned","source":"claims/README.md"}',
    ].join("\n");

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: readAllowedDomains(),
    });

    expect(result.issues.map((issue) => issue.code)).toContain("E_SCHEMA");
    expect(result.issues.map((issue) => issue.code)).toContain("E_ID_DUPLICATE");
  });
});

describe("claims core schema closure", () => {
  test("rejects additional properties", () => {
    const input =
      '{"schemaVersion":1,"domain":"claims","id":"claims.extra.field","surface":"filesystem","path":"claims/canonical.jsonl","claim":"x","status":"planned","source":"claims/README.md","extra":"nope"}\n';

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: readAllowedDomains(),
    });

    expect(result.issues.map((issue) => issue.code)).toContain("E_SCHEMA");
  });

  test("rejects missing required fields", () => {
    const input =
      '{"schemaVersion":1,"domain":"claims","id":"claims.missing.source","surface":"filesystem","path":"claims/canonical.jsonl","claim":"x","status":"planned"}\n';

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: readAllowedDomains(),
    });

    expect(result.issues.map((issue) => issue.code)).toContain("E_SCHEMA");
  });

  test("rejects invalid status enum", () => {
    const input =
      '{"schemaVersion":1,"domain":"claims","id":"claims.bad.status","surface":"filesystem","path":"claims/canonical.jsonl","claim":"x","status":"done","source":"claims/README.md"}\n';

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: readAllowedDomains(),
    });

    expect(result.issues.map((issue) => issue.code)).toContain("E_SCHEMA");
  });

  test("rejects invalid id pattern", () => {
    const input =
      '{"schemaVersion":1,"domain":"claims","id":"Invalid*ID","surface":"filesystem","path":"claims/canonical.jsonl","claim":"x","status":"planned","source":"claims/README.md"}\n';

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: readAllowedDomains(),
    });

    expect(result.issues.map((issue) => issue.code)).toContain("E_SCHEMA");
    expect(result.issues.some((issue) => issue.path === "/id")).toBe(true);
  });
});

describe("claims canonicalization determinism", () => {
  test("sorts strictly by domain then id", () => {
    const input = [
      '{"schemaVersion":1,"domain":"worktree","id":"worktree.z","surface":"git","path":"b","claim":"z","status":"planned","source":"x"}',
      '{"schemaVersion":1,"domain":"claims","id":"claims.b","surface":"filesystem","path":"b","claim":"b","status":"planned","source":"x"}',
      '{"schemaVersion":1,"domain":"claims","id":"claims.a","surface":"filesystem","path":"a","claim":"a","status":"planned","source":"x"}',
      '{"schemaVersion":1,"domain":"worktree","id":"worktree.a","surface":"git","path":"a","claim":"a","status":"planned","source":"x"}',
    ].join("\n");

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: new Set(["claims", "worktree"]),
    });

    expect(result.issues).toEqual([]);
    expect(result.canonicalText).toContain('"domain":"claims","id":"claims.a"');
    expect(result.canonicalText).toContain('"domain":"claims","id":"claims.b"');
    expect(result.canonicalText).toContain('"domain":"worktree","id":"worktree.a"');
    expect(result.canonicalText).toContain('"domain":"worktree","id":"worktree.z"');

    const lines = (result.canonicalText ?? "").trimEnd().split("\n");
    const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);
    expect(ids).toEqual(["claims.a", "claims.b", "worktree.a", "worktree.z"]);
  });

  test("normalizes CRLF to LF and preserves trailing newline", () => {
    const input =
      '{"schemaVersion":1,"domain":"claims","id":"claims.crlf","surface":"filesystem","path":"claims/canonical.jsonl","claim":"x","status":"planned","source":"claims/README.md"}\r\n';

    const result = validateAndCanonicalizeClaimsJsonl(input, {
      validateSchema: buildV1Validator(),
      allowedDomains: readAllowedDomains(),
    });

    expect(result.issues).toEqual([]);
    expect(result.canonicalText?.includes("\r")).toBe(false);
    expect(result.canonicalText?.endsWith("\n")).toBe(true);
  });
});
