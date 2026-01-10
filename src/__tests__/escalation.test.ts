import { describe, expect, test } from "bun:test";

import {
  isAmbiguousRequirementsReason,
  isContractSurfaceReason,
  isExplicitBlockerReason,
  isImplementationTaskFromIssue,
  shouldConsultDevex,
  shouldEscalateAfterRouting,
} from "../escalation";

describe("escalation helpers", () => {
  describe("isImplementationTaskFromIssue", () => {
    test("defaults to implementation-ish", () => {
      expect(isImplementationTaskFromIssue({ labels: [], title: "Anything" })).toBe(true);
      expect(isImplementationTaskFromIssue({ labels: ["p1-high"], title: "Add feature" })).toBe(true);
    });

    test("false when explicitly labeled product/ux/breaking-change", () => {
      expect(isImplementationTaskFromIssue({ labels: ["product"], title: "Whatever" })).toBe(false);
      expect(isImplementationTaskFromIssue({ labels: ["ux"], title: "Whatever" })).toBe(false);
      expect(isImplementationTaskFromIssue({ labels: ["breaking-change"], title: "Whatever" })).toBe(false);
    });

    test("case-insensitive label match", () => {
      expect(isImplementationTaskFromIssue({ labels: ["UX"], title: "Whatever" })).toBe(false);
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

    test("consults devex for low/medium-confidence escalate (remediation attempt)", () => {
      const routing = { decision: "escalate" as const, confidence: "medium" as const, escalation_reason: "style" };
      expect(shouldConsultDevex({ routing, hasGap: false, isImplementationTask: true })).toBe(true);
    });

    test("does not consult devex for high-confidence escalate", () => {
      const routing = { decision: "escalate" as const, confidence: "high" as const, escalation_reason: "" };
      expect(shouldConsultDevex({ routing, hasGap: false, isImplementationTask: true })).toBe(false);
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

  describe("isExplicitBlockerReason", () => {
    test("detects clear blockers", () => {
      expect(isExplicitBlockerReason("blocked on upstream")).toBe(true);
      expect(isExplicitBlockerReason("cannot proceed until access granted")).toBe(true);
      expect(isExplicitBlockerReason("needs human decision")).toBe(true);
      expect(isExplicitBlockerReason("external blocker")).toBe(true);
    });

    test("false for empty/unrelated reasons", () => {
      expect(isExplicitBlockerReason(null)).toBe(false);
      expect(isExplicitBlockerReason("style")).toBe(false);
    });

    test("does not match common negations", () => {
      expect(isExplicitBlockerReason("unblocked")).toBe(false);
      expect(isExplicitBlockerReason("not blocked anymore")).toBe(false);
    });
  });
 
  describe("isAmbiguousRequirementsReason", () => {
    test("detects explicit ambiguity", () => {
      expect(isAmbiguousRequirementsReason("ambiguous requirements")).toBe(true);
      expect(isAmbiguousRequirementsReason("unclear spec")).toBe(true);
      expect(isAmbiguousRequirementsReason("needs clarification")).toBe(true);
      expect(isAmbiguousRequirementsReason("requires clarification")).toBe(true);
    });

    test("false for empty/unrelated reasons", () => {
      expect(isAmbiguousRequirementsReason(null)).toBe(false);
      expect(isAmbiguousRequirementsReason("ambiguous")).toBe(false);
    });
  });

  describe("shouldEscalateAfterRouting", () => {
    test("always escalates on product gap", () => {
      const routing = { decision: "proceed" as const, confidence: "low" as const, escalation_reason: "" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: true })).toBe(true);
    });

    test("always escalates on explicit blocker", () => {
      const routing = { decision: "proceed" as const, confidence: "low" as const, escalation_reason: "blocked" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: false })).toBe(true);
    });

    test("always escalates on ambiguous requirements", () => {
      const routing = { decision: "proceed" as const, confidence: "low" as const, escalation_reason: "ambiguous requirements" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: false })).toBe(true);
    });

    test("always escalates on contract-surface reasons", () => {
      const routing = { decision: "proceed" as const, confidence: "low" as const, escalation_reason: "exit code" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: false })).toBe(true);
    });

    test("escalates only on high-confidence explicit escalate", () => {
      const routing = { decision: "escalate" as const, confidence: "high" as const, escalation_reason: "" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: false })).toBe(true);
    });

    test("does not escalate on low confidence alone", () => {
      const routing = { decision: "proceed" as const, confidence: "low" as const, escalation_reason: "" };
      expect(shouldEscalateAfterRouting({ routing, hasGap: false })).toBe(false);
    });

    test("does not escalate on low/medium-confidence escalate decisions", () => {
      const routingLow = { decision: "escalate" as const, confidence: "low" as const, escalation_reason: "" };
      const routingMedium = { decision: "escalate" as const, confidence: "medium" as const, escalation_reason: "" };
      expect(shouldEscalateAfterRouting({ routing: routingLow, hasGap: false })).toBe(false);
      expect(shouldEscalateAfterRouting({ routing: routingMedium, hasGap: false })).toBe(false);
    });
  });
});
