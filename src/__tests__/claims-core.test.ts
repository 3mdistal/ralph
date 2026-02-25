import { describe, expect, test } from "bun:test";

import { validateAndCanonicalizeClaimsJsonl, type ClaimsSchemaValidator } from "../claims";

const alwaysValidSchema: ClaimsSchemaValidator = Object.assign(
  (_value: unknown): boolean => true,
  { errors: [] as const }
);

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
});
