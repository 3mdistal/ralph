import { normalizeGitRef } from "./midpoint-labels";

export const PR_CREATE_LEASE_SCOPE = "pr-create";
const PR_CREATE_LEASE_VERSION = 1;

export function buildPrCreateLeaseKey(input: {
  repo: string;
  issueNumber: string | number;
  baseBranch: string;
}): string {
  const repo = String(input.repo ?? "").trim();
  const issue = String(input.issueNumber ?? "").trim();
  const base = normalizeGitRef(String(input.baseBranch ?? "")).trim();
  return `pr-create:v${PR_CREATE_LEASE_VERSION}:${repo}#${issue}:${base}`;
}

function parseIsoMs(value: string | null | undefined): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function isLeaseStale(params: {
  createdAtIso: string | null | undefined;
  nowMs: number;
  ttlMs: number;
}): boolean {
  const createdMs = parseIsoMs(params.createdAtIso);
  if (createdMs === null) return false;
  const ttl = Number.isFinite(params.ttlMs) ? Math.max(0, Math.floor(params.ttlMs)) : 0;
  return params.nowMs - createdMs > ttl;
}
