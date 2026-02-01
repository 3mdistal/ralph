import { redactSensitiveText } from "../redaction";
import { hasProductGap } from "../product-gap";

export const CONSULTANT_SCHEMA_VERSION = 2;
export const CONSULTANT_MARKER = "<!-- ralph-consultant:v2 -->";
const CONSULTANT_BRIEF_HEADING = "## Consultant Brief";
const CONSULTANT_DECISION_HEADING = "## Consultant Decision (machine)";

const BRIEF_SENTINEL_START = "RALPH_CONSULTANT_BRIEF_BEGIN";
const BRIEF_SENTINEL_END = "RALPH_CONSULTANT_BRIEF_END";
const JSON_SENTINEL_START = "RALPH_CONSULTANT_JSON_BEGIN";
const JSON_SENTINEL_END = "RALPH_CONSULTANT_JSON_END";

const MAX_BRIEF_CHARS = 4000;
const MAX_REASON_CHARS = 600;
const MAX_PROPOSED_RESOLUTION_CHARS = 2000;
const MAX_JSON_REASON_CHARS = 1200;
const MAX_FOLLOWUP_TITLE_CHARS = 200;
const MAX_FOLLOWUP_BODY_CHARS = 2000;
const MAX_CURRENT_STATE_CHARS = 800;
const MAX_WHATS_MISSING_CHARS = 800;
const MAX_RECOMMENDATION_CHARS = 800;
const MAX_OPTION_CHARS = 240;
const MAX_QUESTION_CHARS = 200;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_QUESTIONS = 3;
const MIN_QUESTIONS = 1;
const MAX_NOTE_CONTEXT_CHARS = 6000;
const MAX_PLAN_CONTEXT_CHARS = 4000;
const MAX_PRODUCT_CONTEXT_CHARS = 2000;
const MAX_DEVEX_CONTEXT_CHARS = 1200;
const MAX_ROUTING_CONTEXT_CHARS = 1200;

export type ConsultantDecision = {
  schema_version: number;
  decision: "auto-resolve" | "needs-human";
  confidence: "high" | "medium" | "low";
  requires_approval: true;
  current_state: string;
  whats_missing: string;
  options: string[];
  recommendation: string;
  questions: string[];
  proposed_resolution_text: string;
  reason: string;
  followups: Array<{ type: "issue"; title: string; body: string }>;
};

export type EscalationConsultantInput = {
  issue: string;
  repo: string;
  taskName: string;
  taskPath?: string | null;
  escalationType: string;
  reason: string;
  sessionId?: string | null;
  githubCommentUrl?: string | null;
  routing?: {
    decision?: string | null;
    confidence?: string | null;
    escalation_reason?: string | null;
    plan_summary?: string | null;
  };
  devex?: {
    consulted?: boolean;
    sessionId?: string | null;
    summary?: string | null;
  };
  planOutput?: string | null;
  noteContent?: string | null;
  createdAt?: string | null;
};

export type ParsedConsultantResponse = {
  brief: string;
  decision: ConsultantDecision;
};

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function sanitizeEscalationText(
  input: string | null | undefined,
  maxChars: number,
  opts?: { homeDir?: string }
): string {
  if (!input) return "";
  const redacted = redactSensitiveText(stripAnsi(String(input)), { homeDir: opts?.homeDir });
  return truncateText(redacted, maxChars);
}

function extractDelimitedBlock(text: string, start: string, end: string): string | null {
  const startIdx = text.indexOf(start);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(end, startIdx + start.length);
  if (endIdx === -1) return null;
  const slice = text.slice(startIdx + start.length, endIdx).trim();
  return slice ? slice : null;
}

function normalizeDecision(value: unknown): "auto-resolve" | "needs-human" {
  return value === "auto-resolve" ? "auto-resolve" : "needs-human";
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "medium" ? value : "low";
}

function normalizeFollowups(value: unknown): Array<{ type: "issue"; title: string; body: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const title = sanitizeEscalationText(String(obj.title ?? ""), MAX_FOLLOWUP_TITLE_CHARS);
      const body = sanitizeEscalationText(String(obj.body ?? ""), MAX_FOLLOWUP_BODY_CHARS);
      if (!title && !body) return null;
      return { type: "issue", title, body };
    })
    .filter((entry): entry is { type: "issue"; title: string; body: string } => Boolean(entry));
}

function normalizeStringField(value: unknown, maxChars: number, fallback: string): string {
  const text = sanitizeEscalationText(String(value ?? ""), maxChars);
  return text || fallback;
}

function normalizeStringList(
  value: unknown,
  opts: {
    label: string;
    maxItems: number;
    minItems: number;
    maxItemChars: number;
    fallback: string[];
  }
): { items: string[]; notes: string[] } {
  const notes: string[] = [];
  const rawItems: string[] = [];

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") rawItems.push(entry);
      else if (entry !== null && entry !== undefined) rawItems.push(String(entry));
    }
  } else if (typeof value === "string") {
    rawItems.push(...value.split(/\r?\n/));
  }

  const cleaned = rawItems
    .map((entry) => entry.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .map((entry) => sanitizeEscalationText(entry, opts.maxItemChars))
    .filter((entry) => Boolean(entry));

  let items = cleaned;
  if (items.length > opts.maxItems) {
    items = items.slice(0, opts.maxItems);
    notes.push(`truncated ${opts.label} to ${opts.maxItems}`);
  }

  if (items.length < opts.minItems) {
    const fallbackItems = opts.fallback
      .map((entry) => sanitizeEscalationText(entry, opts.maxItemChars))
      .filter((entry) => Boolean(entry));
    const seen = new Set(items.map((entry) => entry.toLowerCase()));
    for (const fallback of fallbackItems) {
      if (items.length >= opts.minItems) break;
      if (seen.has(fallback.toLowerCase())) continue;
      items.push(fallback);
      seen.add(fallback.toLowerCase());
    }
  }

  if (items.length > opts.maxItems) {
    items = items.slice(0, opts.maxItems);
  }

  return { items, notes };
}

function appendNotesToReason(reason: string, notes: string[]): string {
  if (notes.length === 0) return reason;
  const suffix = ` (${notes.join("; ")})`;
  if (reason.length + suffix.length <= MAX_JSON_REASON_CHARS) return `${reason}${suffix}`;
  return truncateText(`${reason} ${notes.join("; ")}`.trim(), MAX_JSON_REASON_CHARS);
}

function normalizeConsultantDecision(obj: Record<string, unknown>): ConsultantDecision {
  const notes: string[] = [];
  const parsedSchema = typeof obj.schema_version === "number" ? obj.schema_version : null;
  if (parsedSchema !== null && parsedSchema !== CONSULTANT_SCHEMA_VERSION) {
    notes.push(`normalized schema_version to ${CONSULTANT_SCHEMA_VERSION} from ${parsedSchema}`);
  }

  const decision = normalizeDecision(obj.decision);
  const confidence = normalizeConfidence(obj.confidence);
  const currentState = normalizeStringField(obj.current_state, MAX_CURRENT_STATE_CHARS, "Not provided in consultant output.");
  const whatsMissing = normalizeStringField(obj.whats_missing, MAX_WHATS_MISSING_CHARS, "Not provided in consultant output.");
  const recommendation = normalizeStringField(obj.recommendation, MAX_RECOMMENDATION_CHARS, "Needs human decision.");
  const proposed =
    sanitizeEscalationText(String(obj.proposed_resolution_text ?? ""), MAX_PROPOSED_RESOLUTION_CHARS) || recommendation;
  const reasonBase =
    sanitizeEscalationText(String(obj.reason ?? ""), MAX_JSON_REASON_CHARS) ||
    "Missing or invalid consultant output; defaulting to normalized decision.";
  const followups = normalizeFollowups(obj.followups);

  const optionsResult = normalizeStringList(obj.options, {
    label: "options",
    maxItems: MAX_OPTIONS,
    minItems: MIN_OPTIONS,
    maxItemChars: MAX_OPTION_CHARS,
    fallback: [
      "Provide guidance in the escalation Resolution section.",
      "Defer until requirements are clarified on the issue.",
    ],
  });
  const questionsResult = normalizeStringList(obj.questions, {
    label: "questions",
    maxItems: MAX_QUESTIONS,
    minItems: MIN_QUESTIONS,
    maxItemChars: MAX_QUESTION_CHARS,
    fallback: ["Approve the recommendation?"],
  });

  notes.push(...optionsResult.notes, ...questionsResult.notes);

  return {
    schema_version: CONSULTANT_SCHEMA_VERSION,
    decision,
    confidence,
    requires_approval: true,
    current_state: currentState,
    whats_missing: whatsMissing,
    options: optionsResult.items,
    recommendation,
    questions: questionsResult.items,
    proposed_resolution_text: proposed,
    reason: appendNotesToReason(reasonBase, notes),
    followups,
  };
}

export function parseConsultantResponse(text: string): ParsedConsultantResponse | null {
  const brief = extractDelimitedBlock(text, BRIEF_SENTINEL_START, BRIEF_SENTINEL_END);
  const jsonBlock = extractDelimitedBlock(text, JSON_SENTINEL_START, JSON_SENTINEL_END);
  if (!brief || !jsonBlock) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const normalized = normalizeConsultantDecision(obj);

  return {
    brief: sanitizeEscalationText(brief, MAX_BRIEF_CHARS),
    decision: normalized,
  };
}

function extractProductConsultation(output: string): string | null {
  const patterns = [
    /## Product Review\s*\n([\s\S]*?)(?=\n##|$)/i,
    /\*\*Product[^*]*\*\*[:\s]*([\s\S]*?)(?=\n##|\n\*\*Routing|\{"decision"|$)/i,
    /@product[^:]*:\s*([\s\S]*?)(?=\n##|\n@|$)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]?.trim()) return match[1].trim();
  }
  return null;
}

function extractPlanSummary(output: string): string | null {
  const patterns = [
    /## Implementation Plan\s*\n([\s\S]*?)(?=\n##|$)/i,
    /## Plan\s*\n([\s\S]*?)(?=\n##|$)/i,
    /\*\*Plan[^*]*\*\*[:\s]*([\s\S]*?)(?=\n##|\n\*\*Routing|\{"decision"|$)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]?.trim()) return match[1].trim();
  }
  return null;
}

function buildContextBlock(label: string, content: string): string[] {
  if (!content.trim()) return [];
  return [label, "```", content.trim(), "```", ""];
}

export function buildConsultantPrompt(input: EscalationConsultantInput): string {
  const reason = sanitizeEscalationText(input.reason, MAX_REASON_CHARS);
  const routing = input.routing
    ? sanitizeEscalationText(JSON.stringify(input.routing, null, 2), MAX_ROUTING_CONTEXT_CHARS)
    : "";
  const devex = input.devex
    ? sanitizeEscalationText(JSON.stringify(input.devex, null, 2), MAX_DEVEX_CONTEXT_CHARS)
    : "";
  const planOutput = input.planOutput ?? "";
  const productSummary = planOutput ? extractProductConsultation(planOutput) ?? "" : "";
  const planSummary = planOutput ? extractPlanSummary(planOutput) ?? "" : "";

  const noteContext = sanitizeEscalationText(input.noteContent ?? "", MAX_NOTE_CONTEXT_CHARS);
  const productBlock = sanitizeEscalationText(productSummary, MAX_PRODUCT_CONTEXT_CHARS);
  const planBlock = sanitizeEscalationText(planSummary, MAX_PLAN_CONTEXT_CHARS);

  const isProductGap = input.escalationType === "product-gap" || hasProductGap(input.noteContent ?? "");

  const contextLines = [
    "Escalation summary:",
    `- Issue: ${input.issue}`,
    `- Repo: ${input.repo}`,
    `- Task: ${input.taskName}`,
    input.taskPath ? `- Task path: ${input.taskPath}` : "",
    `- Escalation type: ${input.escalationType}`,
    `- Reason: ${reason || "(missing reason)"}`,
    input.sessionId ? `- Session: ${input.sessionId}` : "",
    input.githubCommentUrl ? `- GitHub comment: ${input.githubCommentUrl}` : "",
    input.createdAt ? `- Created at: ${input.createdAt}` : "",
    "",
  ].filter(Boolean);

  const blocks = [
    ...buildContextBlock("Escalation note context (truncated):", noteContext),
    ...buildContextBlock("Routing context:", routing),
    ...buildContextBlock("Devex context:", devex),
    ...buildContextBlock("Product context:", productBlock),
    ...buildContextBlock("Plan summary:", planBlock),
  ];

  return [
    "You are the escalation consultant. Produce a concise, bounded brief and a machine JSON decision.",
    "Output MUST follow this exact format with sentinels and no extra text:",
    BRIEF_SENTINEL_START,
    "<brief text>",
    BRIEF_SENTINEL_END,
    JSON_SENTINEL_START,
    "<raw JSON object only>",
    JSON_SENTINEL_END,
    "",
    "Brief requirements:",
    "- Include trigger, current state, what's missing, options (2-4), recommendation, questions (1-3).",
    "- Keep it concise; do NOT include huge logs or diffs.",
    "",
    "JSON schema requirements:",
    `- Include schema_version: ${CONSULTANT_SCHEMA_VERSION}`,
    "- decision: \"auto-resolve\" | \"needs-human\"",
    "- confidence: \"high\" | \"medium\" | \"low\"",
    "- requires_approval: true",
    "- current_state: string",
    "- whats_missing: string",
    "- options: string[] (2-4 entries)",
    "- recommendation: string",
    "- questions: string[] (1-3 entries)",
    "- proposed_resolution_text: string",
    "- reason: string",
    "- followups: [{ type: \"issue\", title: string, body: string }]",
    "",
    isProductGap
      ? "Product-gap escalation: decision must be \"needs-human\". Provide 2-4 options and 1-3 crisp approval questions."
      : "",
    "",
    ...contextLines,
    ...blocks,
  ].join("\n");
}

export function buildFallbackPacket(input: EscalationConsultantInput): ParsedConsultantResponse {
  const reason = sanitizeEscalationText(input.reason, MAX_REASON_CHARS);
  const isProductGap = input.escalationType === "product-gap" || hasProductGap(input.noteContent ?? "");
  const currentState = `Task '${input.taskName}' escalated (${input.escalationType}).`;
  const whatsMissing = isProductGap
    ? "Product documentation does not specify the required behavior."
    : "Escalation requires human guidance to proceed.";
  const options = [
    "Provide guidance in the escalation Resolution section.",
    "Defer until requirements are clarified on the issue.",
  ];
  const recommendation = isProductGap
    ? "Approve a decision packet response to fill the product gap."
    : "Provide guidance so the task can resume.";
  const questions = ["Approve the recommendation?"];
  const briefLines = [
    `Trigger: ${reason || "Escalation created"}`,
    `Current state: ${currentState}`,
    `What's missing: ${whatsMissing}`,
    `Context: Issue ${input.issue} in ${input.repo}.`,
    "Options:",
    "- Needs human decision (provide guidance in Resolution section).",
    "- Defer until requirements clarified on the issue.",
    `Recommendation: ${recommendation}`,
    "Questions:",
    "- Approve the recommendation?",
  ];

  const decision: ConsultantDecision = {
    schema_version: CONSULTANT_SCHEMA_VERSION,
    decision: "needs-human",
    confidence: "low",
    requires_approval: true,
    current_state: sanitizeEscalationText(currentState, MAX_CURRENT_STATE_CHARS),
    whats_missing: sanitizeEscalationText(whatsMissing, MAX_WHATS_MISSING_CHARS),
    options: options.map((option) => sanitizeEscalationText(option, MAX_OPTION_CHARS)),
    recommendation: sanitizeEscalationText(recommendation, MAX_RECOMMENDATION_CHARS),
    questions: questions.map((question) => sanitizeEscalationText(question, MAX_QUESTION_CHARS)),
    proposed_resolution_text: "Provide guidance in the escalation Resolution section and requeue when ready.",
    reason: reason || "Missing or invalid consultant output; defaulting to human decision.",
    followups: [],
  };

  return {
    brief: sanitizeEscalationText(briefLines.join("\n"), MAX_BRIEF_CHARS),
    decision,
  };
}

export function renderConsultantPacket(packet: ParsedConsultantResponse): string {
  const json = JSON.stringify(packet.decision, null, 2);
  return [
    CONSULTANT_MARKER,
    CONSULTANT_BRIEF_HEADING,
    packet.brief,
    "",
    CONSULTANT_DECISION_HEADING,
    "```json",
    json,
    "```",
    "",
  ].join("\n");
}
