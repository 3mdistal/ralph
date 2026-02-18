import { describe, expect, test } from "bun:test";

import {
  appendCiQuarantineOccurrence,
  buildCiQuarantineFollowupBody,
  buildCiQuarantineFollowupMarker,
  parseCiQuarantineFollowupState,
} from "../github/ci-quarantine-followup";

describe("CI quarantine follow-up helpers", () => {
  test("marker is deterministic per repo/signature", () => {
    const a = buildCiQuarantineFollowupMarker({ repo: "3mdistal/ralph", signature: "abc" });
    const b = buildCiQuarantineFollowupMarker({ repo: "3mdistal/ralph", signature: "abc" });
    expect(a.marker).toBe(b.marker);
    expect(a.markerId).toBe(b.markerId);
  });

  test("append is idempotent by occurrence key", () => {
    const first = appendCiQuarantineOccurrence({
      previous: null,
      signature: "sig",
      sourceIssueNumber: 732,
      occurrence: {
        key: "k1",
        at: "2026-02-18T00:00:00.000Z",
        sourceIssueNumber: 732,
        prUrl: "https://github.com/3mdistal/ralph/pull/1",
        classification: "infra",
        attempt: 2,
        maxAttempts: 5,
        failingChecks: [{ name: "Test", rawState: "FAILURE" }],
      },
    });
    const second = appendCiQuarantineOccurrence({
      previous: first.state,
      signature: "sig",
      sourceIssueNumber: 732,
      occurrence: {
        key: "k1",
        at: "2026-02-18T00:00:00.000Z",
        sourceIssueNumber: 732,
        prUrl: "https://github.com/3mdistal/ralph/pull/1",
        classification: "infra",
        attempt: 2,
        maxAttempts: 5,
        failingChecks: [{ name: "Test", rawState: "FAILURE" }],
      },
    });
    expect(first.state.occurrenceCount).toBe(1);
    expect(second.state.occurrenceCount).toBe(1);
    expect(second.changed).toBe(false);
    expect(second.state.occurrences).toHaveLength(1);
  });

  test("body embeds parseable state", () => {
    const { marker } = buildCiQuarantineFollowupMarker({ repo: "3mdistal/ralph", signature: "sig" });
    const state = appendCiQuarantineOccurrence({
      previous: null,
      signature: "sig",
      sourceIssueNumber: 732,
      occurrence: {
        key: "k1",
        at: "2026-02-18T00:00:00.000Z",
        sourceIssueNumber: 732,
        prUrl: "https://github.com/3mdistal/ralph/pull/1",
        classification: "infra",
        attempt: 2,
        maxAttempts: 5,
        failingChecks: [{ name: "Test", rawState: "FAILURE" }],
      },
    }).state;
    const body = buildCiQuarantineFollowupBody({ marker, state, sourceIssueRef: "3mdistal/ralph#732" });
    const parsed = parseCiQuarantineFollowupState(body);
    expect(parsed?.signature).toBe("sig");
    expect(parsed?.occurrenceCount).toBe(1);
  });
});
