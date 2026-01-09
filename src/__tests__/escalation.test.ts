import { describe, expect, test } from "bun:test";

import {
  isContractSurfaceReason,
  isImplementationTaskFromIssue,
  shouldConsultDevex,
  shouldEscalateAfterRouting,
} from "../escalation";

describe("escalation helpers", () => {
  describe("isImplementationTaskFromIssue", () => {
    test("true when labels include dx/refactor/bug", () => {
      expect(isImplementationTaskFromIssue({ labels: ["dx"], title: "Normal issue" })).toBe(true);
      expect(isImplementationTaskFromIssue({ labels: ["refactor"], title: "Normal issue" })).toBe(true);
      expect(isImplementationTaskFromIssue({ labels: ["bug"], title: "Normal issue" })).toBe(true);
    });

    test("true when title contains dx/refactor/bug", () => {
      expect(isImplementationTaskFromIssue({ labels: [], title: "DX: speed up routing" })).toBe(true);
      expect(isImplementationTaskFromIssue({ labels: [], title: "Refactor routing" })).toBe(true);
      expect(isImplementationTaskFromIssue({ labels: [], title: "bug: crash on start" })).toBe(true);
    });

    test("false when no signals present", () => {
      expect(isImplementationTaskFromIssue({ labels: ["p1-high"], title: "Add feature" })).toBe(false);
    });
  });

  describe("isContractSurfaceReason", () => {
    test("detects common contract-surface indicators", () => {
      expect(isContractSurfaceReason("change exit code")).toBe(true);
      expect(isContractSurfaceReason("new CLI flag")).toBe(true);
      expect(isContractSurfaceReason("update stdout format")).toBe(true);
      expect(isContractSurfaceReason("public error string")).toBe(true);
      expect(isContractSurfaceReason("config schema change")).toBe(true);
      expect(isContractSurfaceReason("json output mode")).toBe(true);
    });

    test("false for empty/unrelated reasons", () => {
      expect(isContractSurfaceReason(null)).toBe(false);
      expect(isContractSurfaceReason("code style")).toBe(false);
    });
  });

  describe("shouldConsultDevex", () => {
    test("consults devex for implementation tasks with low confidence", () => {
      const routing = { decision: "proceed" as const, confidence: "low" as const, escalation_reason: "" };
      expect(shouldConsultDevex({ routing, hasGap: false, isImplementationTask: true })).toBe(true);
    });

    test("does not consult devex for contract-surface reasons", () => {
      const routing = { decision: "escalate" as const, confidence: "low" as const, escalation_reason: "exit code" };
      expect(shouldConsultDevex({ routing, hasGap: false, isImplementationTask: true })).toBe(false);
    });

    test("does not consult devex when not an implementation task", () => {
      const routing = { decision: "escalate" as const, confidence: "low" as const, escalation_reason: "style" };
      expect(shouldConsultDevex({ routing, hasGap: false, isImplementationTask: false })).toBe(false);
    });

    test("does not consult devex on product gap", () => {
      const routing = { decision: "escalate" as const, confidence: "low" as const, escalation_reason: "docs missing" };
      expect(shouldConsultDevex({ routing, hasGap: true, isImplementationTask: true })).toBe(false);
    });
  });

  describe("shouldEscalateAfterRouting", () => {
    test("always escalates on explicit high-confidence escalate", () => {
      const routing = { decision: "escalate" as const, confidence: "high" as const, escalation_reason: "" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: false, isImplementationTask: true })).toBe(true);
    });

    test("ignores product gap for implementation tasks unless explicit escalate", () => {
      const routing = { decision: "proceed" as const, confidence: "medium" as const, escalation_reason: "" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: true, isImplementationTask: true })).toBe(false);
    });

    test("escalates on low confidence by default", () => {
      const routing = { decision: "proceed" as const, confidence: "low" as const, escalation_reason: "" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: false, isImplementationTask: false })).toBe(true);
    });
  });
});
