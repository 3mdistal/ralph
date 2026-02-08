import { createHash } from "crypto";
import { isContractSurfaceReason } from "../escalation";
import { patchResolutionSection } from "../escalation-notes";
import { hasProductGap } from "../product-gap";
import type { EscalationType } from "../github/escalation-constants";
import type { ConsultantDecision } from "../escalation-consultant/core";

export const AUTO_RESOLVE_MAX_ATTEMPTS = 2;

type LoopLedgerEntry = {
  attempts: number;
  lastAt?: string;
};

type LoopLedger = {
  version: 1;
  bySignature: Record<string, LoopLedgerEntry>;
};

export type EligibilityInput = {
  escalationType: EscalationType;
  reason: string;
  noteContent: string;
  decision: ConsultantDecision;
};

export type EligibilityResult =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "missing-consultant-decision"
        | "decision-not-auto-resolve"
        | "confidence-too-low"
        | "missing-resolution-text"
        | "product-gap"
        | "contract-surface"
        | "type-not-allowlisted"
        | "blocked-not-dependency-ref";
    };

export type LoopBudgetResult = {
  allowed: boolean;
  attempts: number;
  ledgerJson: string;
  reason: "ok" | "max-attempts";
};

function parseJsonFenceAfterHeading(noteContent: string, heading: string): Record<string, unknown> | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escapedHeading + "\\s*\\n\\s*```json\\s*\\n([\\s\\S]*?)\\n```", "i");
  const match = noteContent.match(re);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeDecision(raw: Record<string, unknown>): ConsultantDecision {
  return {
    schema_version: Number(raw.schema_version) || 0,
    decision: raw.decision === "auto-resolve" ? "auto-resolve" : "needs-human",
    confidence: raw.confidence === "high" || raw.confidence === "medium" ? raw.confidence : "low",
    requires_approval: true,
    current_state: String(raw.current_state ?? ""),
    whats_missing: String(raw.whats_missing ?? ""),
    options: Array.isArray(raw.options) ? raw.options.map((v) => String(v ?? "")) : [],
    recommendation: String(raw.recommendation ?? ""),
    questions: Array.isArray(raw.questions) ? raw.questions.map((v) => String(v ?? "")) : [],
    proposed_resolution_text: String(raw.proposed_resolution_text ?? ""),
    reason: String(raw.reason ?? ""),
    followups: [],
  };
}

export function parseConsultantDecisionFromEscalationNote(noteContent: string): ConsultantDecision | null {
  const raw = parseJsonFenceAfterHeading(noteContent, "## Consultant Decision (machine)");
  if (!raw) return null;
  return normalizeDecision(raw);
}

function parseDependencyBlockedRef(reason: string): string | null {
  const match = reason.match(/\bblocked\s+by\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)\b/i);
  return match?.[1] ?? null;
}

export function evaluateAutopilotEligibility(input: EligibilityInput): EligibilityResult {
  if (!input.decision) return { eligible: false, reason: "missing-consultant-decision" };
  if (input.decision.decision !== "auto-resolve") return { eligible: false, reason: "decision-not-auto-resolve" };
  if (input.decision.confidence !== "high") return { eligible: false, reason: "confidence-too-low" };

  const resolution = String(input.decision.proposed_resolution_text ?? "").trim();
  if (!resolution) return { eligible: false, reason: "missing-resolution-text" };

  if (input.escalationType === "product-gap" || hasProductGap(input.noteContent)) {
    return { eligible: false, reason: "product-gap" };
  }

  const contractReason = `${input.reason}\n${input.decision.reason || ""}`;
  if (isContractSurfaceReason(contractReason)) {
    return { eligible: false, reason: "contract-surface" };
  }

  if (input.escalationType === "blocked") {
    if (!parseDependencyBlockedRef(input.reason)) {
      return { eligible: false, reason: "blocked-not-dependency-ref" };
    }
    return { eligible: true };
  }

  if (input.escalationType === "watchdog" || input.escalationType === "low-confidence") {
    return { eligible: true };
  }

  return { eligible: false, reason: "type-not-allowlisted" };
}

function parseLoopLedger(raw: string | undefined): LoopLedger {
  if (!raw) return { version: 1, bySignature: {} };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; bySignature?: unknown };
    if (!parsed || typeof parsed !== "object") return { version: 1, bySignature: {} };
    const bySignatureRaw = parsed.bySignature && typeof parsed.bySignature === "object" ? parsed.bySignature : {};
    const bySignature: Record<string, LoopLedgerEntry> = {};
    for (const [key, value] of Object.entries(bySignatureRaw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const attempts = Number(v.attempts);
      bySignature[key] = {
        attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
        lastAt: typeof v.lastAt === "string" ? v.lastAt : undefined,
      };
    }
    return { version: 1, bySignature };
  } catch {
    return { version: 1, bySignature: {} };
  }
}

export function computeEscalationSignature(input: {
  escalationType: EscalationType;
  reason: string;
  decision: ConsultantDecision;
}): string {
  const normalizedReason = input.reason.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedDecisionReason = String(input.decision.reason ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const base = `${input.escalationType}|${normalizedReason}|${normalizedDecisionReason}|${input.decision.decision}`;
  return createHash("sha1").update(base).digest("hex").slice(0, 16);
}

export function computeLoopBudget(params: {
  ledgerRaw: string | undefined;
  signature: string;
  nowIso: string;
  maxAttempts?: number;
}): LoopBudgetResult {
  const maxAttempts = params.maxAttempts ?? AUTO_RESOLVE_MAX_ATTEMPTS;
  const ledger = parseLoopLedger(params.ledgerRaw);
  const existing = ledger.bySignature[params.signature] ?? { attempts: 0 };
  if (existing.attempts >= maxAttempts) {
    return {
      allowed: false,
      attempts: existing.attempts,
      reason: "max-attempts",
      ledgerJson: JSON.stringify(ledger),
    };
  }

  const attempts = existing.attempts + 1;
  ledger.bySignature[params.signature] = { attempts, lastAt: params.nowIso };
  return {
    allowed: true,
    attempts,
    reason: "ok",
    ledgerJson: JSON.stringify(ledger),
  };
}

export function applyAutopilotResolutionPatch(noteContent: string, resolutionText: string): {
  changed: boolean;
  noteContent: string;
  reason: "updated" | "already-filled";
} {
  const patched = patchResolutionSection(noteContent, resolutionText);
  return {
    changed: patched.changed,
    noteContent: patched.markdown,
    reason: patched.reason,
  };
}
