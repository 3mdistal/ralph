import { createHash } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";
import type { AgentEscalationNote } from "../escalation-notes";
import { normalizeEscalationType } from "../github/escalation-constants";
import type { EscalationConsultantInput } from "./core";
import { appendConsultantPacket } from "./io";
import {
  applyAutopilotResolutionPatch,
  AUTO_RESOLVE_MAX_ATTEMPTS,
  computeEscalationSignature,
  computeLoopBudget,
  evaluateAutopilotEligibility,
  parseConsultantDecisionFromEscalationNote,
} from "../escalation-autopilot/core";
import { hasIdempotencyKey, initStateDb, recordIdempotencyKey } from "../state";
import type { AgentTask } from "../queue/types";
import type { EditEscalationResult } from "../escalation-notes";

export type EscalationConsultantSchedulerDeps = {
  getEscalationsByStatus: (status: string) => Promise<AgentEscalationNote[]>;
  getVaultPath: () => string | null;
  isShuttingDown: () => boolean;
  allowModelSend: () => Promise<boolean>;
  repoPath: () => string;
  editEscalation: (path: string, fields: Record<string, string>) => Promise<EditEscalationResult>;
  getTaskByPath: (taskPath: string) => Promise<AgentTask | null>;
  updateTaskStatus: (task: AgentTask, status: AgentTask["status"], fields?: Record<string, string | number>) => Promise<boolean>;
  nowIso?: () => string;
  log?: (message: string) => void;
};

type SchedulerState = { inFlight: boolean };


function resolveNotePath(vault: string, notePath: string): string {
  return isAbsolute(notePath) ? notePath : join(vault, notePath);
}

function parseSummaryField(text: string, field: string): string {
  const re = new RegExp(`\\|\\s*${field}\\s*\\|\\s*([^|]+)\\|`, "i");
  const match = text.match(re);
  return match?.[1]?.trim() ?? "";
}

function parseEscalationReason(text: string): string {
  return parseSummaryField(text, "Reason") || "Escalation created";
}

function parseEscalationType(text: string): ReturnType<typeof normalizeEscalationType> {
  return normalizeEscalationType(parseSummaryField(text, "Type"));
}

function toTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeAutopilotIdempotencyKey(notePath: string, signature: string): string {
  const hash = createHash("sha1").update(`${notePath}|${signature}`).digest("hex").slice(0, 16);
  return `escalation-autopilot:v1:${hash}`;
}

function hasSuppressionMarker(noteContent: string, signature: string): boolean {
  return noteContent.includes(`ralph-autopilot:suppressed signature=${signature} `);
}

function appendSuppressionMarker(noteContent: string, signature: string, reason: string, nowIso: string): string {
  if (hasSuppressionMarker(noteContent, signature)) return noteContent;
  const marker = `<!-- ralph-autopilot:suppressed signature=${signature} reason=${reason} at=${nowIso} -->`;
  const base = noteContent.endsWith("\n") ? noteContent : `${noteContent}\n`;
  return `${base}\n${marker}\n`;
}

function buildInputFromEscalation(params: {
  escalation: AgentEscalationNote;
  noteContent: string;
}): EscalationConsultantInput {
  const noteContent = params.noteContent;
  const creationDate = params.escalation["creation-date"] ?? null;
  const escalationType =
    typeof params.escalation["escalation-type"] === "string"
      ? normalizeEscalationType(params.escalation["escalation-type"])
      : parseEscalationType(noteContent);

  return {
    issue: params.escalation.issue ?? "",
    repo: params.escalation.repo ?? "",
    taskName: params.escalation._name ?? "",
    taskPath: params.escalation["task-path"] ?? null,
    escalationType,
    reason: parseEscalationReason(noteContent),
    sessionId: params.escalation["session-id"] ?? null,
    noteContent,
    createdAt: creationDate,
  };
}

export function createEscalationConsultantScheduler(deps: EscalationConsultantSchedulerDeps) {
  const state: SchedulerState = { inFlight: false };
  const nowIso = () => deps.nowIso?.() ?? new Date().toISOString();

  const tick = async (): Promise<void> => {
    if (state.inFlight) return;
    if (deps.isShuttingDown()) return;

    const vault = deps.getVaultPath();
    if (!vault) return;

    state.inFlight = true;
    try {
      initStateDb();
      const escalations = await deps.getEscalationsByStatus("pending");
      if (escalations.length === 0) return;

      const sorted = escalations
        .slice()
        .sort((a, b) => {
          const aDate = toTimestamp(a["creation-date"]);
          const bDate = toTimestamp(b["creation-date"]);
          return aDate - bDate;
        });

      for (const escalation of sorted) {
        if (deps.isShuttingDown()) return;
        const notePath = resolveNotePath(vault, escalation._path);
        try {
          let noteContent = await readFile(notePath, "utf8");
          const input = buildInputFromEscalation({ escalation, noteContent });

          let decision = parseConsultantDecisionFromEscalationNote(noteContent);
          if (!decision) {
            const allow = await deps.allowModelSend();
            if (!allow) continue;

            const result = await appendConsultantPacket(notePath, input, {
              repoPath: deps.repoPath(),
              log: deps.log,
            });
            if (result.status === "appended") {
              noteContent = await readFile(notePath, "utf8");
              decision = parseConsultantDecisionFromEscalationNote(noteContent);
            }
          }

          if (!decision) continue;

          const signature = computeEscalationSignature({
            escalationType: input.escalationType,
            reason: input.reason,
            decision,
          });

          const eligibility = evaluateAutopilotEligibility({
            escalationType: input.escalationType,
            reason: input.reason,
            decision,
            noteContent,
          });
          if (!eligibility.eligible) {
            const suppressed = appendSuppressionMarker(noteContent, signature, eligibility.reason, nowIso());
            if (suppressed !== noteContent) {
              await writeFile(notePath, suppressed, "utf8");
            }
            deps.log?.(
              `[ralph:consultant] auto-resolve suppressed for ${escalation._path} reason=${eligibility.reason} signature=${signature}`
            );
            continue;
          }

          const taskPath = escalation["task-path"]?.trim() ?? "";
          if (!taskPath) continue;
          const task = await deps.getTaskByPath(taskPath);
          if (!task) continue;

          const budget = computeLoopBudget({
            ledgerRaw: task["auto-resolve-ledger"],
            signature,
            nowIso: nowIso(),
            maxAttempts: AUTO_RESOLVE_MAX_ATTEMPTS,
          });
          if (!budget.allowed) {
            const suppressed = appendSuppressionMarker(noteContent, signature, budget.reason, nowIso());
            if (suppressed !== noteContent) {
              await writeFile(notePath, suppressed, "utf8");
            }
            deps.log?.(
              `[ralph:consultant] auto-resolve suppressed for ${escalation._path} reason=${budget.reason} attempts=${budget.attempts} signature=${signature}`
            );
            continue;
          }

          const idempotencyKey = makeAutopilotIdempotencyKey(escalation._path, signature);
          if (hasIdempotencyKey(idempotencyKey)) {
            deps.log?.(`[ralph:consultant] auto-resolve already applied for ${escalation._path} signature=${signature}`);
            continue;
          }

          const patch = applyAutopilotResolutionPatch(noteContent, decision.proposed_resolution_text);
          if (!patch.changed) {
            const suppressed = appendSuppressionMarker(noteContent, signature, patch.reason, nowIso());
            if (suppressed !== noteContent) {
              await writeFile(notePath, suppressed, "utf8");
            }
            continue;
          }

          await writeFile(notePath, patch.noteContent, "utf8");
          const resolved = await deps.editEscalation(escalation._path, { status: "resolved" });
          if (!resolved.ok) {
            deps.log?.(
              `[ralph:consultant] auto-resolve writeback failed for ${escalation._path}: ${resolved.error}`
            );
            continue;
          }

          await deps.updateTaskStatus(task, task.status, {
            "auto-resolve-ledger": budget.ledgerJson,
            "auto-resolve-last-at": nowIso(),
          });
          recordIdempotencyKey({
            key: idempotencyKey,
            scope: "escalation-autopilot",
            payloadJson: JSON.stringify({ escalationPath: escalation._path, signature, attempts: budget.attempts }),
          });
          deps.log?.(
            `[ralph:consultant] auto-resolve applied for ${escalation._path} type=${input.escalationType} attempts=${budget.attempts}/${AUTO_RESOLVE_MAX_ATTEMPTS} signature=${signature}`
          );
          return;
        } catch (error: any) {
          deps.log?.(`[ralph:consultant] Failed to read escalation note ${notePath}: ${error?.message ?? String(error)}`);
        }
      }
    } finally {
      state.inFlight = false;
    }
  };

  return { tick };
}
