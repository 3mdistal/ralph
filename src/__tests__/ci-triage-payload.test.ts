import { describe, expect, test } from "bun:test";

import {
  CI_TRIAGE_CLASSIFIER_KIND,
  CI_TRIAGE_CLASSIFIER_VERSION,
  buildCiTriageClassifierPayloadV1,
  formatCiTriageClassifierSummary,
  parseCiTriageClassifierLegacyArtifact,
  parseCiTriageClassifierPayload,
} from "../ci-triage/payload";

describe("ci triage payload codec", () => {
  test("parses supported persisted payload v1", () => {
    const payload = buildCiTriageClassifierPayloadV1({
      signatureVersion: 2,
      signature: "abc123",
      classification: "regression",
      classificationReason: "regression_checks",
      action: "resume",
      actionReason: "resume_has_session",
      timedOut: false,
      attempt: 1,
      maxAttempts: 5,
      priorSignature: null,
      failingChecks: [{ name: "Test", rawState: "FAILURE", detailsUrl: "https://example.test/run/1" }],
      commands: ["bun test"],
    });

    const parsed = parseCiTriageClassifierPayload({
      version: CI_TRIAGE_CLASSIFIER_VERSION,
      payloadJson: JSON.stringify(payload),
    });

    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.payload.kind).toBe(CI_TRIAGE_CLASSIFIER_KIND);
    expect(parsed.payload.version).toBe(1);
    expect(formatCiTriageClassifierSummary(parsed.payload)).toContain("classification=regression");
  });

  test("returns unsupported for unknown persisted versions", () => {
    const parsed = parseCiTriageClassifierPayload({
      version: 99,
      payloadJson: JSON.stringify({ kind: CI_TRIAGE_CLASSIFIER_KIND, version: 99 }),
    });
    expect(parsed).toEqual({ status: "unsupported_version", version: 99, payload: null });
  });

  test("parses legacy artifact payload format", () => {
    const legacy = {
      version: 1,
      signatureVersion: 2,
      signature: "legacy-sig",
      classification: "infra",
      classificationReason: "infra_timeout",
      action: "spawn",
      actionReason: "spawn_flake_or_infra",
      timedOut: true,
      attempt: 2,
      maxAttempts: 5,
      priorSignature: null,
      failingChecks: [{ name: "CI", rawState: "TIMED_OUT", detailsUrl: null }],
      commands: [],
    };
    const parsed = parseCiTriageClassifierLegacyArtifact(JSON.stringify(legacy));
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.payload.kind).toBe(CI_TRIAGE_CLASSIFIER_KIND);
    expect(parsed.payload.signature).toBe("legacy-sig");
  });

  test("returns invalid for malformed payload JSON", () => {
    const parsed = parseCiTriageClassifierPayload({ version: 1, payloadJson: "{not-json" });
    expect(parsed.status).toBe("invalid");
  });
});
