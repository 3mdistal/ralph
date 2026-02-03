import type { IssueRef } from "../github/issue-ref";
import type { IssueRelationshipSnapshot } from "../github/issue-relationships";
import type { RelationshipSignal } from "../github/issue-blocking-core";
import { normalizePrUrl } from "../github/pr";

export const CHILD_DOSSIER_HEADER = "Child completion dossier";

export type ChildCompletionDossierLimits = {
  maxChildren: number;
  maxPrsPerChild: number;
  maxExcerptChars: number;
  maxChars: number;
};

export type ChildCompletionDossierEligibility = {
  decision: "eligible" | "skip";
  reason: string;
  childIssues: IssueRef[];
};

export type ChildCompletionPr = {
  url: string;
  title?: string | null;
  merged?: boolean | null;
  mergeCommitUrl?: string | null;
  bodyExcerpt?: string | null;
};

export type ChildCompletionChild = {
  issue: IssueRef;
  url: string;
  title?: string | null;
  state?: string | null;
  prs: ChildCompletionPr[];
};

export type ChildCompletionDossier = {
  children: ChildCompletionChild[];
  totalChildren: number;
  omittedChildren: number;
  incompleteReason?: string;
};

const DEFAULT_LIMITS: ChildCompletionDossierLimits = {
  maxChildren: 25,
  maxPrsPerChild: 2,
  maxExcerptChars: 400,
  maxChars: 12_000,
};

function dedupeIssues(issues: IssueRef[]): IssueRef[] {
  const seen = new Set<string>();
  const output: IssueRef[] = [];
  for (const issue of issues) {
    const key = `${issue.repo}#${issue.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(issue);
  }
  return output;
}

function sortIssues(issues: IssueRef[]): IssueRef[] {
  return [...issues].sort((a, b) => {
    const repoCompare = a.repo.localeCompare(b.repo);
    if (repoCompare !== 0) return repoCompare;
    return a.number - b.number;
  });
}

function normalizeText(input: string | null | undefined): string {
  return String(input ?? "").trim();
}

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatValue(input: string | null | undefined, fallback: string): string {
  const value = normalizeText(input);
  return value ? value : fallback;
}

function normalizePrCandidates(prs: ChildCompletionPr[], maxPrs: number): ChildCompletionPr[] {
  const seen = new Set<string>();
  const normalized = prs
    .map((pr) => ({
      ...pr,
      url: normalizePrUrl(pr.url || ""),
    }))
    .filter((pr) => pr.url)
    .sort((a, b) => a.url.localeCompare(b.url));

  const output: ChildCompletionPr[] = [];
  for (const pr of normalized) {
    if (output.length >= maxPrs) break;
    if (seen.has(pr.url)) continue;
    seen.add(pr.url);
    output.push(pr);
  }
  return output;
}

export function resolveChildCompletionLimits(
  overrides?: Partial<ChildCompletionDossierLimits>
): ChildCompletionDossierLimits {
  return {
    maxChildren: Math.max(1, Math.min(100, Math.floor(overrides?.maxChildren ?? DEFAULT_LIMITS.maxChildren))),
    maxPrsPerChild: Math.max(1, Math.min(10, Math.floor(overrides?.maxPrsPerChild ?? DEFAULT_LIMITS.maxPrsPerChild))),
    maxExcerptChars: Math.max(8, Math.min(1200, Math.floor(overrides?.maxExcerptChars ?? DEFAULT_LIMITS.maxExcerptChars))),
    maxChars: Math.max(2_000, Math.min(20_000, Math.floor(overrides?.maxChars ?? DEFAULT_LIMITS.maxChars))),
  };
}

export function evaluateChildCompletionEligibility(params: {
  snapshot: IssueRelationshipSnapshot;
  signals: RelationshipSignal[];
}): ChildCompletionDossierEligibility {
  const childSignals = params.signals.filter((signal) => signal.kind === "sub_issue" && signal.ref);
  const childIssues = sortIssues(dedupeIssues(childSignals.map((signal) => signal.ref!).filter(Boolean)));

  if (!params.snapshot.coverage.githubSubIssuesComplete) {
    return { decision: "skip", reason: "sub-issue coverage incomplete", childIssues };
  }

  if (childIssues.length === 0) {
    return { decision: "skip", reason: "no sub-issues detected", childIssues };
  }

  const hasOpenSubIssue = childSignals.some((signal) => signal.state === "open");
  if (hasOpenSubIssue) {
    return { decision: "skip", reason: "sub-issue still open", childIssues };
  }

  const hasUnknownSubIssue = childSignals.some((signal) => signal.state === "unknown");
  if (hasUnknownSubIssue) {
    return { decision: "skip", reason: "sub-issue coverage unknown", childIssues };
  }

  return { decision: "eligible", reason: "all sub-issues closed", childIssues };
}

export function selectBoundedChildren(params: { childIssues: IssueRef[]; maxChildren: number }): {
  selected: IssueRef[];
  omitted: number;
} {
  const ordered = sortIssues(dedupeIssues(params.childIssues));
  const selected = ordered.slice(0, params.maxChildren);
  const omitted = Math.max(0, ordered.length - selected.length);
  return { selected, omitted };
}

export function compileChildCompletionDossier(params: {
  children: ChildCompletionChild[];
  totalChildren: number;
  omittedChildren: number;
  incompleteReason?: string;
  limits?: Partial<ChildCompletionDossierLimits>;
}): { dossier: ChildCompletionDossier; text: string } {
  const limits = resolveChildCompletionLimits(params.limits);
  const children = [...params.children]
    .sort((a, b) => {
      const repoCompare = a.issue.repo.localeCompare(b.issue.repo);
      if (repoCompare !== 0) return repoCompare;
      const numberCompare = a.issue.number - b.issue.number;
      if (numberCompare !== 0) return numberCompare;
      return a.url.localeCompare(b.url);
    })
    .map((child) => ({
      ...child,
      prs: normalizePrCandidates(child.prs, limits.maxPrsPerChild),
    }));

  const dossier: ChildCompletionDossier = {
    children,
    totalChildren: Math.max(0, params.totalChildren),
    omittedChildren: Math.max(0, params.omittedChildren),
    incompleteReason: params.incompleteReason?.trim() || undefined,
  };

  const lines: string[] = [];
  lines.push(`${CHILD_DOSSIER_HEADER} (auto-generated; best-effort; may be partial)`);
  const shown = dossier.children.length;
  const total = dossier.totalChildren || shown;
  const omitted = dossier.omittedChildren;
  const childLine = `Child issues: ${shown}/${total}${omitted > 0 ? ` (omitted ${omitted} due to limits)` : ""}`;
  lines.push(childLine);

  if (dossier.incompleteReason) {
    lines.push(`Note: dossier incomplete (${dossier.incompleteReason}).`);
  }

  if (dossier.children.length === 0) {
    lines.push("(no child issues recorded)");
  }

  for (const child of dossier.children) {
    const title = formatValue(child.title, "(title unavailable)");
    const state = formatValue(child.state, "unknown");
    lines.push(`- ${child.url} — ${title} [${state}]`);

    if (child.prs.length === 0) {
      lines.push("  PRs: (none found)");
      continue;
    }

    lines.push("  PRs:");
    for (const pr of child.prs) {
      const prTitle = formatValue(pr.title, "(title unavailable)");
      const merged = pr.merged === true ? "merged" : pr.merged === false ? "not merged" : "merge unknown";
      lines.push(`  - ${pr.url} — ${prTitle} [${merged}]`);
      if (pr.mergeCommitUrl) {
        lines.push(`    Merge commit: ${pr.mergeCommitUrl}`);
      }
      if (pr.bodyExcerpt) {
        const excerpt = truncateText(pr.bodyExcerpt, limits.maxExcerptChars);
        lines.push(`    Excerpt: ${excerpt}`);
      }
    }
  }

  const text = truncateText(lines.join("\n"), limits.maxChars);
  return { dossier, text };
}

export function appendChildDossierToIssueContext(issueContext: string, dossierText: string): string {
  const base = String(issueContext ?? "").trimEnd();
  const appendix = String(dossierText ?? "").trim();
  if (!appendix) return base;
  return [base, "", appendix].filter(Boolean).join("\n");
}
