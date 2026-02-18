import { splitRepoFullName, type GitHubClient } from "./client";

export type CiQuarantineFollowupOccurrence = {
  key: string;
  at: string;
  sourceIssueNumber: number;
  prUrl: string;
  classification: string;
  attempt: number;
  maxAttempts: number;
  failingChecks: Array<{ name: string; rawState: string; detailsUrl?: string | null }>;
};

export type CiQuarantineFollowupState = {
  version: 1;
  signature: string;
  sourceIssueNumber: number;
  occurrenceCount: number;
  lastSeenAt: string;
  occurrences: CiQuarantineFollowupOccurrence[];
};

export type CiQuarantineFollowupIssue = {
  number: number;
  url: string;
  state: "open" | "closed";
  body: string;
};

const FOLLOWUP_MARKER_REGEX = /<!--\s*ralph-ci-quarantine:id=([a-z0-9]+)\s*-->/i;
const FOLLOWUP_STATE_REGEX = /<!--\s*ralph-ci-quarantine:state=([^>]+)\s*-->/i;
const MAX_OCCURRENCES = 20;

function hashFNV1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildCiQuarantineFollowupMarker(params: { repo: string; signature: string }): { markerId: string; marker: string } {
  const base = `${params.repo}|${params.signature}`;
  const markerId = `${hashFNV1a(base)}${hashFNV1a(base.split("").reverse().join(""))}`.slice(0, 12);
  return { markerId, marker: `<!-- ralph-ci-quarantine:id=${markerId} -->` };
}

export function parseCiQuarantineFollowupState(body: string): CiQuarantineFollowupState | null {
  const match = body.match(FOLLOWUP_STATE_REGEX);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as CiQuarantineFollowupState;
    if (!parsed || parsed.version !== 1) return null;
    if (!parsed.signature || !Number.isInteger(parsed.sourceIssueNumber)) return null;
    if (!Array.isArray(parsed.occurrences)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildCiQuarantineFollowupBody(params: {
  marker: string;
  state: CiQuarantineFollowupState;
  sourceIssueRef: string;
}): string {
  const lines: string[] = [];
  lines.push(params.marker);
  lines.push(`<!-- ralph-ci-quarantine:state=${JSON.stringify(params.state)} -->`);
  lines.push("");
  lines.push("CI quarantine follow-up");
  lines.push("");
  lines.push(`Source issue: ${params.sourceIssueRef}`);
  lines.push(`Signature: ${params.state.signature}`);
  lines.push(`Occurrences: ${params.state.occurrenceCount}`);
  lines.push(`Last seen: ${params.state.lastSeenAt}`);
  lines.push("");
  lines.push("Recent occurrences:");
  if (params.state.occurrences.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of params.state.occurrences) {
      const checks = item.failingChecks.slice(0, 3).map((check) => `${check.name}:${check.rawState}`).join(", ") || "(none)";
      lines.push(
        `- ${item.at} source=#${item.sourceIssueNumber} attempt=${item.attempt}/${item.maxAttempts} class=${item.classification} pr=${item.prUrl}`
      );
      lines.push(`  - checks: ${checks}`);
    }
  }
  return lines.join("\n");
}

export function appendCiQuarantineOccurrence(params: {
  previous: CiQuarantineFollowupState | null;
  signature: string;
  sourceIssueNumber: number;
  occurrence: CiQuarantineFollowupOccurrence;
}): { state: CiQuarantineFollowupState; changed: boolean } {
  const existing = params.previous;
  const occurrences = [...(existing?.occurrences ?? [])];
  const alreadyPresent = occurrences.some((item) => item.key === params.occurrence.key);
  if (!alreadyPresent) {
    occurrences.unshift(params.occurrence);
  }
  const trimmed = occurrences.slice(0, MAX_OCCURRENCES);
  const occurrenceCount = (existing?.occurrenceCount ?? 0) + (alreadyPresent ? 0 : 1);
  const state: CiQuarantineFollowupState = {
    version: 1,
    signature: params.signature,
    sourceIssueNumber: params.sourceIssueNumber,
    occurrenceCount,
    lastSeenAt: params.occurrence.at,
    occurrences: trimmed,
  };
  const changed = !existing || JSON.stringify(existing) !== JSON.stringify(state);
  return { state, changed };
}

export async function findOpenCiQuarantineIssueByMarker(params: {
  github: GitHubClient;
  repo: string;
  marker: string;
}): Promise<CiQuarantineFollowupIssue | null> {
  const { owner, name } = splitRepoFullName(params.repo);
  const query = encodeURIComponent(`repo:${params.repo} is:issue is:open in:body "${params.marker}"`);
  const response = await params.github.request<{
    items?: Array<{ number?: number; html_url?: string | null; body?: string | null; state?: string | null }>;
  }>(`/search/issues?q=${query}&per_page=1`);
  const item = response.data?.items?.[0];
  if (!item?.number) return null;
  return {
    number: item.number,
    url: item.html_url ?? `https://github.com/${owner}/${name}/issues/${item.number}`,
    state: String(item.state ?? "open").toLowerCase() === "closed" ? "closed" : "open",
    body: item.body ?? "",
  };
}

export async function getCiQuarantineIssue(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
}): Promise<CiQuarantineFollowupIssue | null> {
  const { owner, name } = splitRepoFullName(params.repo);
  try {
    const response = await params.github.request<{
      number?: number;
      html_url?: string | null;
      body?: string | null;
      state?: string | null;
    }>(`/repos/${owner}/${name}/issues/${params.issueNumber}`);
    const number = Number(response.data?.number ?? 0);
    if (!number) return null;
    return {
      number,
      url: response.data?.html_url ?? `https://github.com/${owner}/${name}/issues/${number}`,
      state: String(response.data?.state ?? "open").toLowerCase() === "closed" ? "closed" : "open",
      body: response.data?.body ?? "",
    };
  } catch {
    return null;
  }
}

export async function createCiQuarantineIssue(params: {
  github: GitHubClient;
  repo: string;
  title: string;
  body: string;
}): Promise<CiQuarantineFollowupIssue> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<{ number?: number; html_url?: string | null; body?: string | null; state?: string | null }>(
    `/repos/${owner}/${name}/issues`,
    {
      method: "POST",
      body: { title: params.title, body: params.body },
    }
  );
  const number = Number(response.data?.number ?? 0);
  if (!number) {
    throw new Error("failed to create CI quarantine follow-up issue");
  }
  return {
    number,
    url: response.data?.html_url ?? `https://github.com/${owner}/${name}/issues/${number}`,
    state: String(response.data?.state ?? "open").toLowerCase() === "closed" ? "closed" : "open",
    body: response.data?.body ?? params.body,
  };
}

export async function updateCiQuarantineIssue(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  title?: string;
  body: string;
  reopen?: boolean;
}): Promise<CiQuarantineFollowupIssue> {
  const { owner, name } = splitRepoFullName(params.repo);
  const payload: Record<string, unknown> = { body: params.body };
  if (params.title) payload.title = params.title;
  if (params.reopen) payload.state = "open";
  const response = await params.github.request<{ number?: number; html_url?: string | null; body?: string | null; state?: string | null }>(
    `/repos/${owner}/${name}/issues/${params.issueNumber}`,
    {
      method: "PATCH",
      body: payload,
    }
  );
  const number = Number(response.data?.number ?? params.issueNumber);
  return {
    number,
    url: response.data?.html_url ?? `https://github.com/${owner}/${name}/issues/${number}`,
    state: String(response.data?.state ?? "open").toLowerCase() === "closed" ? "closed" : "open",
    body: response.data?.body ?? params.body,
  };
}
