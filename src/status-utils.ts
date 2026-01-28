import { formatDuration } from "./logging";
import { formatNowDoingLine, getSessionNowDoing } from "./live-status";
import type { AgentTask } from "./queue-backend";

export function formatTaskLabel(task: Pick<AgentTask, "name" | "issue" | "repo">): string {
  const issueMatch = task.issue.match(/#(\d+)$/);
  const issueNumber = issueMatch?.[1] ?? "?";
  const repoShort = task.repo.includes("/") ? task.repo.split("/")[1] : task.repo;
  return `${repoShort}#${issueNumber} ${task.name}`;
}

export function formatBlockedIdleSuffix(task: AgentTask): string {
  const blockedAt = task["blocked-at"]?.trim() ?? "";
  if (!blockedAt) return "";
  const blockedAtMs = Date.parse(blockedAt);
  if (!Number.isFinite(blockedAtMs)) return "";
  return ` [idle ${formatDuration(Date.now() - blockedAtMs)}]`;
}

export function summarizeBlockedDetailsSnippet(text: string, maxChars = 500): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd() + "…";
}

export async function getTaskNowDoingLine(task: AgentTask): Promise<string> {
  const sessionId = task["session-id"]?.trim();
  const label = formatTaskLabel(task);

  if (!sessionId) return `${label} — starting session…`;

  const nowDoing = await getSessionNowDoing(sessionId);
  if (!nowDoing) return `${label} — waiting (no events yet)`;

  return formatNowDoingLine(nowDoing, label);
}

export function getTaskOpencodeProfileName(task: Pick<AgentTask, "opencode-profile">): string | null {
  const raw = task["opencode-profile"];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

export function formatActiveOpencodeProfileLine(params: {
  requestedProfile: string | null;
  resolvedProfile: string | null;
  selectionSource: "requested" | "auto" | "failover";
}): string | null {
  if (params.requestedProfile === "auto") {
    return `Active OpenCode profile: auto (resolved: ${params.resolvedProfile ?? "ambient"})`;
  }

  if (params.selectionSource === "failover") {
    return `Active OpenCode profile: ${params.resolvedProfile ?? "ambient"} (failover from: ${params.requestedProfile ?? "default"})`;
  }

  if (params.resolvedProfile) {
    return `Active OpenCode profile: ${params.resolvedProfile}`;
  }

  return null;
}
