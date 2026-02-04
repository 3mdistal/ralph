export type CiFailureClassification = "regression" | "flake-suspected" | "infra";

export type CiNextAction = "resume" | "spawn" | "quarantine";

export type CiTriageClassificationReason =
  | "infra_timeout"
  | "infra_non_actionable"
  | "infra_network"
  | "flake_transient"
  | "regression_checks"
  | "regression_commands"
  | "regression_unknown";

export type CiTriageActionReason =
  | "quarantine_repeated_signature"
  | "resume_has_session"
  | "spawn_no_session"
  | "spawn_regression"
  | "spawn_flake_or_infra";

export type CiTriageInput = {
  timedOut: boolean;
  failures: Array<{ name: string; rawState: string; excerpt?: string | null }>;
  commands: string[];
  attempt: number;
  maxAttempts: number;
  hasSession: boolean;
  signature: string;
  priorSignature?: string | null;
};

export type CiTriageDecision = {
  classification: CiFailureClassification;
  classificationReason: CiTriageClassificationReason;
  action: CiNextAction;
  actionReason: CiTriageActionReason;
};

const INFRA_EXCERPT_PATTERNS = [
  "econnreset",
  "etimedout",
  "eai_again",
  "enotfound",
  "socket hang up",
  "connection reset",
  "temporary failure",
  "network error",
  "network connection",
  "service unavailable",
  "internal server error",
  "rate limit",
  "http 5",
  "tls",
];

const FLAKE_EXCERPT_PATTERNS = ["flaky", "flake", "intermittent", "nondeterministic", "re-run", "rerun", "retry"];

const REGRESSION_CHECK_KEYWORDS = ["test", "lint", "typecheck", "build", "knip"];

const NON_ACTIONABLE_RAW_STATES = ["action_required", "stale", "cancel"];

function containsPattern(source: string, patterns: string[]): boolean {
  return patterns.some((pattern) => source.includes(pattern));
}

function normalizeFailureText(failures: CiTriageInput["failures"]): string {
  return failures
    .map((failure) => failure.excerpt ?? "")
    .join("\n")
    .toLowerCase();
}

function isNonActionable(rawState: string): boolean {
  const normalized = rawState.trim().toLowerCase();
  return NON_ACTIONABLE_RAW_STATES.some((marker) => normalized.includes(marker));
}

function classifyCiFailure(input: CiTriageInput): {
  classification: CiFailureClassification;
  reason: CiTriageClassificationReason;
} {
  if (input.timedOut) {
    return { classification: "infra", reason: "infra_timeout" };
  }

  const rawStates = input.failures.map((failure) => failure.rawState.trim().toLowerCase());
  if (rawStates.some((state) => state.includes("timed_out"))) {
    return { classification: "infra", reason: "infra_timeout" };
  }

  if (rawStates.some((state) => isNonActionable(state))) {
    return { classification: "infra", reason: "infra_non_actionable" };
  }

  const excerptText = normalizeFailureText(input.failures);
  if (excerptText && containsPattern(excerptText, INFRA_EXCERPT_PATTERNS)) {
    return { classification: "infra", reason: "infra_network" };
  }

  if (excerptText && containsPattern(excerptText, FLAKE_EXCERPT_PATTERNS)) {
    return { classification: "flake-suspected", reason: "flake_transient" };
  }

  const checkNames = input.failures.map((failure) => failure.name.toLowerCase());
  if (checkNames.some((name) => REGRESSION_CHECK_KEYWORDS.some((kw) => name.includes(kw)))) {
    return { classification: "regression", reason: "regression_checks" };
  }

  const commandText = input.commands.join(" ").toLowerCase();
  if (commandText && REGRESSION_CHECK_KEYWORDS.some((kw) => commandText.includes(kw))) {
    return { classification: "regression", reason: "regression_commands" };
  }

  return { classification: "regression", reason: "regression_unknown" };
}

function decideCiNextAction(input: CiTriageInput, classification: CiFailureClassification): {
  action: CiNextAction;
  reason: CiTriageActionReason;
} {
  const repeated = Boolean(input.priorSignature && input.priorSignature === input.signature);
  if (repeated && classification !== "regression") {
    return { action: "quarantine", reason: "quarantine_repeated_signature" };
  }

  if (classification === "regression" && input.hasSession && input.attempt <= 1) {
    return { action: "resume", reason: "resume_has_session" };
  }

  if (!input.hasSession) {
    return { action: "spawn", reason: "spawn_no_session" };
  }

  if (classification === "regression") {
    return { action: "spawn", reason: "spawn_regression" };
  }

  return { action: "spawn", reason: "spawn_flake_or_infra" };
}

export function buildCiTriageDecision(input: CiTriageInput): CiTriageDecision {
  const classification = classifyCiFailure(input);
  const action = decideCiNextAction(input, classification.classification);
  return {
    classification: classification.classification,
    classificationReason: classification.reason,
    action: action.action,
    actionReason: action.reason,
  };
}
