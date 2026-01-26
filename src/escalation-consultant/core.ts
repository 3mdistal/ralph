import { redactSensitiveText } from "../redaction";

export const CONSULTANT_SCHEMA_VERSION = 1;
export const CONSULTANT_MARKER = "<!-- ralph-consultant:v1 -->";
export const CONSULTANT_BRIEF_HEADING = "## Consultant Brief";
export const CONSULTANT_DECISION_HEADING = "## Consultant Decision (machine)";

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
  const decision = normalizeDecision(obj.decision);
  const confidence = normalizeConfidence(obj.confidence);
  const proposed = sanitizeEscalationText(String(obj.proposed_resolution_text ?? ""), MAX_PROPOSED_RESOLUTION_CHARS);
  const reason = sanitizeEscalationText(String(obj.reason ?? ""), MAX_JSON_REASON_CHARS);
  const followups = normalizeFollowups(obj.followups);

  const normalized: ConsultantDecision = {
    schema_version: CONSULTANT_SCHEMA_VERSION,
    decision,
    confidence,
    requires_approval: true,
    proposed_resolution_text: proposed,
    reason,
    followups,
  };

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
    "- Include trigger, current state, relevant context, options (2-4), recommendation.",
    "- Keep it concise; do NOT include huge logs or diffs.",
    "",
    "JSON schema requirements:",
    `- Include schema_version: ${CONSULTANT_SCHEMA_VERSION}`,
    "- decision: \"auto-resolve\" | \"needs-human\"",
    "- confidence: \"high\" | \"medium\" | \"low\"",
    "- requires_approval: true",
    "- proposed_resolution_text: string",
    "- reason: string",
    "- followups: [{ type: \"issue\", title: string, body: string }]",
    "",
    ...contextLines,
    ...blocks,
  ].join("\n");
}

export function buildFallbackPacket(input: EscalationConsultantInput): ParsedConsultantResponse {
  const reason = sanitizeEscalationText(input.reason, MAX_REASON_CHARS);
  const briefLines = [
    `Trigger: ${reason || "Escalation created"}`,
    `Current state: Task '${input.taskName}' escalated (${input.escalationType}).`,
    `Context: Issue ${input.issue} in ${input.repo}.`,
    "Options:",
    "- Needs human decision (provide guidance in Resolution section).",
    "- Defer until requirements clarified on the issue.",
    "Recommendation: Needs human decision.",
  ];

  const decision: ConsultantDecision = {
    schema_version: CONSULTANT_SCHEMA_VERSION,
    decision: "needs-human",
    confidence: "low",
    requires_approval: true,
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
