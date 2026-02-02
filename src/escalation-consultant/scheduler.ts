import { readFile } from "fs/promises";
import { isAbsolute, join } from "path";
import type { AgentEscalationNote } from "../escalation-notes";
import { normalizeEscalationType } from "../github/escalation-constants";
import type { EscalationConsultantInput } from "./core";
import { appendConsultantPacket } from "./io";

export type EscalationConsultantSchedulerDeps = {
  getEscalationsByStatus: (status: string) => Promise<AgentEscalationNote[]>;
  getVaultPath: () => string | null;
  isShuttingDown: () => boolean;
  allowModelSend: () => Promise<boolean>;
  repoPath: () => string;
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

function buildInputFromEscalation(params: {
  escalation: AgentEscalationNote;
  noteContent: string;
}): EscalationConsultantInput {
  const meta = params.escalation as unknown as Record<string, unknown>;
  const noteContent = params.noteContent;
  const creationDate = typeof meta["creation-date"] === "string" ? (meta["creation-date"] as string) : null;
  const escalationType =
    typeof meta["escalation-type"] === "string"
      ? normalizeEscalationType(meta["escalation-type"] as string)
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

  const tick = async (): Promise<void> => {
    if (state.inFlight) return;
    if (deps.isShuttingDown()) return;

    const vault = deps.getVaultPath();
    if (!vault) return;

    const allow = await deps.allowModelSend();
    if (!allow) return;

    state.inFlight = true;
    try {
      const escalations = await deps.getEscalationsByStatus("pending");
      if (escalations.length === 0) return;

      const sorted = escalations
        .slice()
        .sort((a, b) => {
          const aDate = toTimestamp(((a as unknown) as Record<string, unknown>)["creation-date"] as string | undefined);
          const bDate = toTimestamp(((b as unknown) as Record<string, unknown>)["creation-date"] as string | undefined);
          return aDate - bDate;
        });

      for (const escalation of sorted) {
        if (deps.isShuttingDown()) return;
        const notePath = resolveNotePath(vault, escalation._path);
        try {
          const noteContent = await readFile(notePath, "utf8");
          const input = buildInputFromEscalation({ escalation, noteContent });

          const result = await appendConsultantPacket(notePath, input, {
            repoPath: deps.repoPath(),
            log: deps.log,
          });
          if (result.status === "appended") return;
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
