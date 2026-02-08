import { $ } from "bun";
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
  "escalation-type"?: string;
  "resume-status"?: string;
  "resume-attempted-at"?: string;
  "resume-deferred-at"?: string;
  "resume-error"?: string;
}

export type EditEscalationResult =
  | { ok: true }
  | {
      ok: false;
      kind: "unsupported";
      error: string;
    };

export async function getEscalationsByStatus(status: string): Promise<AgentEscalationNote[]> {
  void status;
  return [];
}

export async function editEscalation(
  escalationPath: string,
  fields: Record<string, string>
): Promise<EditEscalationResult> {
  void escalationPath;
  void fields;
  return { ok: false, kind: "unsupported", error: "Escalation note editing is disabled." };
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
      // Ignore HTML comments used as placeholders.
      if (t.startsWith("<!--") && t.endsWith("-->") && t.length <= 400) return false;
      return true;
    })
    .join("\n")
    .trim();

  return cleaned ? cleaned : null;
}

export type PatchResolutionSectionResult = {
  changed: boolean;
  markdown: string;
  reason: "updated" | "already-filled";
};

function splitNonEmptyLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function patchResolutionSection(markdown: string, resolutionText: string): PatchResolutionSectionResult {
  const nextResolution = splitNonEmptyLines(resolutionText).join("\n").trim();
  if (!nextResolution) {
    return { changed: false, markdown, reason: "already-filled" };
  }

  const existing = extractResolutionSection(markdown);
  if (existing) {
    return { changed: false, markdown, reason: "already-filled" };
  }

  const lines = markdown.split(/\r?\n/);
  const headerRe = /^##\s+resolution\s*$/i;
  const nextHeaderRe = /^##\s+\S/;

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i] ?? "")) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    const insert = ["## Resolution", "", ...nextResolution.split("\n"), ""];
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^##\s+next\s+steps\s*$/i.test(lines[i] ?? "")) {
        insertAt = i;
        break;
      }
    }
    const updated = [...lines.slice(0, insertAt), ...insert, ...lines.slice(insertAt)].join("\n");
    return { changed: true, markdown: updated, reason: "updated" };
  }

  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (nextHeaderRe.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  const updatedLines = [
    ...lines.slice(0, headerIdx + 1),
    "",
    ...nextResolution.split("\n"),
    "",
    ...lines.slice(sectionEnd),
  ];

  return { changed: true, markdown: updatedLines.join("\n"), reason: "updated" };
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
