import { describe, expect, test } from "bun:test";

import { evaluateDurableStateCapability, normalizeSchemaWindow } from "../durable-state-capability";

describe("durable-state capability evaluator", () => {
  const window = normalizeSchemaWindow({ minReadableSchema: 2, maxReadableSchema: 6, maxWritableSchema: 5 });

  test("returns unreadable_forward_incompatible when schema is below minReadableSchema", () => {
    const capability = evaluateDurableStateCapability({ schemaVersion: 1, window });
    expect(capability.readable).toBeFalse();
    expect(capability.writable).toBeFalse();
    expect(capability.verdict).toBe("unreadable_forward_incompatible");
  });

  test("returns readable_writable at maxWritableSchema boundary", () => {
    const capability = evaluateDurableStateCapability({ schemaVersion: 5, window });
    expect(capability.readable).toBeTrue();
    expect(capability.writable).toBeTrue();
    expect(capability.verdict).toBe("readable_writable");
  });

  test("returns readable_readonly_forward_newer between writable and readable maxima", () => {
    const capability = evaluateDurableStateCapability({ schemaVersion: 6, window });
    expect(capability.readable).toBeTrue();
    expect(capability.writable).toBeFalse();
    expect(capability.verdict).toBe("readable_readonly_forward_newer");
  });

  test("returns unreadable_forward_incompatible above maxReadableSchema", () => {
    const capability = evaluateDurableStateCapability({ schemaVersion: 7, window });
    expect(capability.readable).toBeFalse();
    expect(capability.writable).toBeFalse();
    expect(capability.verdict).toBe("unreadable_forward_incompatible");
  });

  test("rejects invalid window ordering", () => {
    expect(() => normalizeSchemaWindow({ minReadableSchema: 3, maxReadableSchema: 3, maxWritableSchema: 2 })).toThrow(
      /maxWritableSchema must be >= minReadableSchema/
    );
  });
});
