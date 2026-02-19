import type {
  CiFailureClassification,
  CiNextAction,
  CiTriageActionReason,
  CiTriageClassificationReason,
} from "./core";

export const CI_TRIAGE_CLASSIFIER_KIND = "ci-triage-classifier";
export const CI_TRIAGE_CLASSIFIER_VERSION = 1;

const MAX_FAILING_CHECKS = 20;
const MAX_COMMANDS = 20;
const MAX_TEXT_VALUE_CHARS = 500;

function sanitizeText(value: string | null | undefined, maxChars = MAX_TEXT_VALUE_CHARS): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars).trimEnd();
}

function sanitizeOptionalText(value: string | null | undefined, maxChars = MAX_TEXT_VALUE_CHARS): string | null {
  const sanitized = sanitizeText(value, maxChars);
  return sanitized ? sanitized : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const sanitized = sanitizeText(String(item ?? ""));
    if (!sanitized) continue;
    out.push(sanitized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function asFailingChecks(value: unknown): CiTriageClassifierPayloadV1["failingChecks"] {
  if (!Array.isArray(value)) return [];
  const out: CiTriageClassifierPayloadV1["failingChecks"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = sanitizeText(String(row.name ?? ""));
    const rawState = sanitizeText(String(row.rawState ?? ""));
    if (!name || !rawState) continue;
    out.push({
      name,
      rawState,
      detailsUrl: sanitizeOptionalText(typeof row.detailsUrl === "string" ? row.detailsUrl : null),
    });
    if (out.length >= MAX_FAILING_CHECKS) break;
  }
  return out;
}

export type CiTriageClassifierPayloadV1 = {
  kind: typeof CI_TRIAGE_CLASSIFIER_KIND;
  version: typeof CI_TRIAGE_CLASSIFIER_VERSION;
  signatureVersion: 2;
  signature: string;
  classification: CiFailureClassification;
  classificationReason: CiTriageClassificationReason;
  action: CiNextAction;
  actionReason: CiTriageActionReason;
  timedOut: boolean;
  attempt: number;
  maxAttempts: number;
  priorSignature: string | null;
  failingChecks: Array<{ name: string; rawState: string; detailsUrl: string | null }>;
  commands: string[];
};

export type CiTriageClassifierPayload = CiTriageClassifierPayloadV1;

export type ParsedCiTriageClassifierPayload =
  | {
      status: "ok";
      version: number;
      payload: CiTriageClassifierPayload;
    }
  | {
      status: "unsupported_version";
      version: number;
      payload: null;
    }
  | {
      status: "invalid";
      version: null;
      payload: null;
    };

function isSupportedClassification(value: unknown): value is CiFailureClassification {
  return value === "regression" || value === "flake-suspected" || value === "infra";
}

function isSupportedAction(value: unknown): value is CiNextAction {
  return value === "resume" || value === "spawn" || value === "quarantine";
}

function isSupportedClassificationReason(value: unknown): value is CiTriageClassificationReason {
  return (
    value === "infra_timeout" ||
    value === "infra_non_actionable" ||
    value === "infra_network" ||
    value === "flake_transient" ||
    value === "regression_checks" ||
    value === "regression_commands" ||
    value === "regression_unknown"
  );
}

function isSupportedActionReason(value: unknown): value is CiTriageActionReason {
  return (
    value === "quarantine_repeated_signature" ||
    value === "resume_has_session" ||
    value === "spawn_no_session" ||
    value === "spawn_regression" ||
    value === "spawn_flake_or_infra"
  );
}

function normalizeV1Payload(raw: Record<string, unknown>): CiTriageClassifierPayloadV1 | null {
  const signatureVersion = asPositiveInt(raw.signatureVersion);
  const attempt = asPositiveInt(raw.attempt);
  const maxAttempts = asPositiveInt(raw.maxAttempts);
  const signature = sanitizeText(typeof raw.signature === "string" ? raw.signature : "");
  if (
    raw.kind !== CI_TRIAGE_CLASSIFIER_KIND ||
    signatureVersion !== 2 ||
    !attempt ||
    !maxAttempts ||
    !signature ||
    !isSupportedClassification(raw.classification) ||
    !isSupportedClassificationReason(raw.classificationReason) ||
    !isSupportedAction(raw.action) ||
    !isSupportedActionReason(raw.actionReason)
  ) {
    return null;
  }

  return {
    kind: CI_TRIAGE_CLASSIFIER_KIND,
    version: 1,
    signatureVersion: 2,
    signature,
    classification: raw.classification,
    classificationReason: raw.classificationReason,
    action: raw.action,
    actionReason: raw.actionReason,
    timedOut: asBoolean(raw.timedOut),
    attempt,
    maxAttempts,
    priorSignature: sanitizeOptionalText(typeof raw.priorSignature === "string" ? raw.priorSignature : null),
    failingChecks: asFailingChecks(raw.failingChecks),
    commands: asStringArray(raw.commands, MAX_COMMANDS),
  };
}

function normalizeLegacyV1Payload(raw: Record<string, unknown>): CiTriageClassifierPayloadV1 | null {
  if (asPositiveInt(raw.version) !== 1) return null;
  return normalizeV1Payload({
    ...raw,
    kind: CI_TRIAGE_CLASSIFIER_KIND,
    version: 1,
  });
}

export function buildCiTriageClassifierPayloadV1(params: {
  signatureVersion: 2;
  signature: string;
  classification: CiFailureClassification;
  classificationReason: CiTriageClassificationReason;
  action: CiNextAction;
  actionReason: CiTriageActionReason;
  timedOut: boolean;
  attempt: number;
  maxAttempts: number;
  priorSignature: string | null;
  failingChecks: Array<{ name: string; rawState: string; detailsUrl?: string | null }>;
  commands: string[];
}): CiTriageClassifierPayloadV1 {
  return {
    kind: CI_TRIAGE_CLASSIFIER_KIND,
    version: 1,
    signatureVersion: 2,
    signature: sanitizeText(params.signature),
    classification: params.classification,
    classificationReason: params.classificationReason,
    action: params.action,
    actionReason: params.actionReason,
    timedOut: params.timedOut === true,
    attempt: Math.max(1, Math.floor(params.attempt)),
    maxAttempts: Math.max(1, Math.floor(params.maxAttempts)),
    priorSignature: sanitizeOptionalText(params.priorSignature),
    failingChecks: params.failingChecks
      .map((check) => ({
        name: sanitizeText(check.name),
        rawState: sanitizeText(check.rawState),
        detailsUrl: sanitizeOptionalText(check.detailsUrl ?? null),
      }))
      .filter((check) => check.name && check.rawState)
      .slice(0, MAX_FAILING_CHECKS),
    commands: params.commands.map((command) => sanitizeText(command)).filter(Boolean).slice(0, MAX_COMMANDS),
  };
}

export function parseCiTriageClassifierPayload(params: {
  version: number | null;
  payloadJson: string | null;
}): ParsedCiTriageClassifierPayload {
  const version = asPositiveInt(params.version);
  if (!version) {
    return { status: "invalid", version: null, payload: null };
  }
  if (version !== 1) {
    return { status: "unsupported_version", version, payload: null };
  }
  const rawJson = String(params.payloadJson ?? "").trim();
  if (!rawJson) {
    return { status: "invalid", version: null, payload: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { status: "invalid", version: null, payload: null };
  }

  if (!parsed || typeof parsed !== "object") {
    return { status: "invalid", version: null, payload: null };
  }

  const normalized = normalizeV1Payload(parsed as Record<string, unknown>);
  if (!normalized) {
    return { status: "invalid", version: null, payload: null };
  }

  return { status: "ok", version: 1, payload: normalized };
}

export function parseCiTriageClassifierLegacyArtifact(content: string): ParsedCiTriageClassifierPayload {
  const rawJson = String(content ?? "").trim();
  if (!rawJson) {
    return { status: "invalid", version: null, payload: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { status: "invalid", version: null, payload: null };
  }

  if (!parsed || typeof parsed !== "object") {
    return { status: "invalid", version: null, payload: null };
  }

  const asRecord = parsed as Record<string, unknown>;
  const normalizedCurrent = normalizeV1Payload(asRecord);
  if (normalizedCurrent) {
    return { status: "ok", version: 1, payload: normalizedCurrent };
  }

  const normalizedLegacy = normalizeLegacyV1Payload(asRecord);
  if (normalizedLegacy) {
    return { status: "ok", version: 1, payload: normalizedLegacy };
  }

  return { status: "invalid", version: null, payload: null };
}

export function formatCiTriageClassifierSummary(payload: CiTriageClassifierPayload): string {
  return (
    `classification=${payload.classification} action=${payload.action} ` +
    `attempt=${payload.attempt}/${payload.maxAttempts} signature=${payload.signature}`
  );
}
