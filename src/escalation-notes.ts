import { readFile } from "fs/promises";

export interface AgentEscalationNote {
  _path: string;
  _name: string;
  type: "agent-escalation";
  "creation-date"?: string;
  status: string;
  repo?: string;
  issue?: string;
  "task-path"?: string;
  "session-id"?: string;
  "resume-status"?: string;
  "resume-attempted-at"?: string;
  "resume-deferred-at"?: string;
  "resume-error"?: string;
}

export type EditEscalationResult =
  | { ok: true }
  | {
      ok: false;
      kind: "storage-unavailable" | "io-error";
      error: string;
    };

export async function getEscalationsByStatus(_status: string): Promise<AgentEscalationNote[]> {
  return [];
}

export async function editEscalation(_escalationPath: string, _fields: Record<string, string>): Promise<EditEscalationResult> {
  return {
    ok: false,
    kind: "storage-unavailable",
    error: "Escalation note storage is disabled; use GitHub comments and command labels.",
  };
}

export function extractResolutionSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);

  const headerRe = /^##\s+resolution\s*$/i;
  const nextHeaderRe = /^##\s+\S/;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i] ?? "")) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return null;

  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (nextHeaderRe.test(line)) break;
    collected.push(line);
  }

  const cleaned = collected
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (t.startsWith("<!--") && t.endsWith("-->") && t.length <= 400) return false;
      return true;
    })
    .join("\n")
    .trim();

  return cleaned ? cleaned : null;
}

export async function readResolutionMessage(notePath: string): Promise<string | null> {
  try {
    const md = await readFile(notePath, "utf8");
    return extractResolutionSection(md);
  } catch (e: any) {
    console.warn(`[ralph:escalations] Failed to read escalation note ${notePath}: ${e?.message ?? String(e)}`);
    return null;
  }
}
