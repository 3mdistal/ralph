import type { IssueLabel, IssuePayload } from "./issues-sync-types";

const DEFAULT_SKEW_SECONDS = 5;

export type IssueStorePlan = {
  issueRef: string;
  title?: string;
  state?: string;
  url?: string;
  githubNodeId?: string;
  githubUpdatedAt?: string;
  labels: string[];
};

export function computeSince(lastSyncAt: string | null, skewSeconds = DEFAULT_SKEW_SECONDS): string | null {
  if (!lastSyncAt) return null;
  const parsed = Date.parse(lastSyncAt);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed - skewSeconds * 1000).toISOString();
}

export function extractLabelNames(labels: IssueLabel[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const label of labels) {
    if (typeof label === "string") {
      const trimmed = label.trim();
      if (trimmed) out.push(trimmed);
      continue;
    }
    const name = typeof label?.name === "string" ? label.name.trim() : "";
    if (name) out.push(name);
  }
  return out;
}

function hasRalphLabel(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase().startsWith("ralph:"));
}

export function normalizeIssueState(state?: string): string | undefined {
  return state ? state.toUpperCase() : undefined;
}

export function shouldStoreIssue(params: {
  hasRalph: boolean;
  hasSnapshot: boolean;
  storeAllOpen?: boolean;
  normalizedState?: string;
}): boolean {
  if (params.hasRalph || params.hasSnapshot) return true;
  if (!params.storeAllOpen) return false;
  return params.normalizedState !== "CLOSED";
}

export function buildIssueStorePlan(params: {
  repo: string;
  issues: IssuePayload[];
  storeAllOpen?: boolean;
  hasIssueSnapshot: (repo: string, issue: string) => boolean;
}): { plans: IssueStorePlan[]; ralphCount: number } {
  const plans: IssueStorePlan[] = [];
  let ralphCount = 0;

  for (const issue of params.issues) {
    const number = issue.number ? String(issue.number) : "";
    if (!number) continue;

    const labels = extractLabelNames(issue.labels);
    const issueRef = `${params.repo}#${number}`;
    const hasRalph = hasRalphLabel(labels);
    if (hasRalph) ralphCount += 1;

    const normalizedState = normalizeIssueState(issue.state);
    const hasSnapshot = params.hasIssueSnapshot(params.repo, issueRef);
    const shouldStore = shouldStoreIssue({
      hasRalph,
      hasSnapshot,
      storeAllOpen: params.storeAllOpen,
      normalizedState,
    });
    if (!shouldStore) continue;

    plans.push({
      issueRef,
      title: issue.title ?? undefined,
      state: normalizedState,
      url: issue.html_url ?? undefined,
      githubNodeId: issue.node_id ?? undefined,
      githubUpdatedAt: issue.updated_at ?? undefined,
      labels,
    });
  }

  return { plans, ralphCount };
}

export function computeNewLastSyncAt(params: {
  fetched: number;
  maxUpdatedAt: string | null;
  lastSyncAt: string | null;
  nowIso: string;
}): string | null {
  if (params.fetched <= 0) return params.lastSyncAt ?? null;
  return params.maxUpdatedAt ?? params.lastSyncAt ?? params.nowIso;
}
