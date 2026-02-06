import type { GitHubClient } from "./client";
import { splitRepoFullName } from "./client";
import {
  CONSULTANT_MARKER,
  renderConsultantPacket,
  type EscalationConsultantInput,
} from "../escalation-consultant/core";
import { generateConsultantPacket } from "../escalation-consultant/io";

type IssueCommentResponse = {
  body?: string | null;
  html_url?: string | null;
};

function parseIssueCommentId(url: string): number | null {
  const match = String(url).match(/issuecomment-(\d+)/i);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function hasConsultantPacket(body: string): boolean {
  return body.includes(CONSULTANT_MARKER) || body.includes(CONSULTANT_MARKER.replace(":v1", ""));
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function buildApprovalInstructions(): string {
  return [
    "## Approval",
    "To resume work:",
    "- Apply `ralph:cmd:queue`",
    "",
    "Optional guidance:",
    "- Comment with your decision or notes (plain text)",
    "",
  ].join("\n");
}

export async function ensureEscalationCommentHasConsultantPacket(params: {
  github: GitHubClient;
  repo: string;
  escalationCommentUrl: string;
  input: EscalationConsultantInput;
  repoPath: string;
  log?: (message: string) => void;
}): Promise<{ ok: boolean; patched: boolean; reason?: string }>
{
  const commentId = parseIssueCommentId(params.escalationCommentUrl);
  if (!commentId) return { ok: false, patched: false, reason: "invalid escalationCommentUrl (missing comment id)" };

  const { owner, name } = splitRepoFullName(params.repo);
  const log = params.log;
  const prefix = `[ralph:gh-consultant:${params.repo}]`;

  let existingBody = "";
  try {
    const existing = await params.github.request<IssueCommentResponse>(`/repos/${owner}/${name}/issues/comments/${commentId}`);
    existingBody = existing.data?.body ?? "";
  } catch (error: any) {
    return { ok: false, patched: false, reason: error?.message ?? String(error) };
  }

  if (hasConsultantPacket(existingBody)) {
    return { ok: true, patched: false, reason: "consultant packet already present" };
  }

  const { packet } = await generateConsultantPacket(params.input, {
    repoPath: params.repoPath,
    log: (m: string) => log?.(`${prefix} ${m}`),
  });

  const consultant = renderConsultantPacket(packet);

  const patchedBody = [
    ensureTrailingNewline(existingBody),
    "",
    "---",
    "",
    consultant.trimEnd(),
    "",
    buildApprovalInstructions().trimEnd(),
    "",
  ].join("\n");

  try {
    await params.github.request<IssueCommentResponse>(`/repos/${owner}/${name}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: { body: patchedBody },
    });
    return { ok: true, patched: true };
  } catch (error: any) {
    return { ok: false, patched: false, reason: error?.message ?? String(error) };
  }
}
