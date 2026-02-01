import { formatAlertDetails, formatAlertSummary } from "./core";

export type WorkerFailureKind = "blocked" | "runtime-error" | "tool-error" | "unhandled-exception";

export type WorkerFailurePointers = {
  sessionId?: string | null;
  worktreePath?: string | null;
  runLogPath?: string | null;
  workerId?: string | null;
  repoSlot?: string | null;
};

export type WorkerFailureAlertInput = {
  kind: WorkerFailureKind;
  stage: string;
  reason: string;
  details?: string | null;
  pointers?: WorkerFailurePointers | null;
};

export type WorkerFailureAlert = {
  fingerprintSeed: string;
  summary: string;
  details: string | null;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatPointer(label: string, value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return `${label}: ${trimmed}`;
}

export function buildWorkerFailureAlert(input: WorkerFailureAlertInput): WorkerFailureAlert {
  const stageLabel = input.stage.trim() || "unknown";
  const reason = input.reason.trim() || "(no reason provided)";
  const summary = formatAlertSummary(`Worker failure (${input.kind}) at ${stageLabel}: ${reason}`);
  const signatureReason = normalizeWhitespace(reason);
  const fingerprintSeed = `worker-failure|${input.kind}|${stageLabel}|${signatureReason}`;

  const pointerLines = [
    formatPointer("Stage", stageLabel),
    formatPointer("Session", input.pointers?.sessionId ?? undefined),
    formatPointer("Worktree", input.pointers?.worktreePath ?? undefined),
    formatPointer("Run log", input.pointers?.runLogPath ?? undefined),
    formatPointer("Worker", input.pointers?.workerId ?? undefined),
    formatPointer("Repo slot", input.pointers?.repoSlot ?? undefined),
  ].filter(Boolean) as string[];

  const detailLines = [
    `Reason: ${reason}`,
    pointerLines.length ? "Pointers:" : null,
    ...pointerLines.map((line) => `- ${line}`),
    input.details?.trim() ? "Diagnostics:" : null,
    input.details?.trim() ? input.details.trim() : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    fingerprintSeed,
    summary,
    details: detailLines ? formatAlertDetails(detailLines) : null,
  };
}
