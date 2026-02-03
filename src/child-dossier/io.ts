import { GitHubClient, splitRepoFullName, type GitHubApiError } from "../github/client";
import { searchMergedPullRequestsByIssueLink, normalizePrUrl } from "../github/pr";
import { PR_STATE_MERGED, listMergedPrCandidatesForIssue, recordPrSnapshot } from "../state";
import type { IssueRef } from "../github/issue-ref";
import type { IssueRelationshipSnapshot } from "../github/issue-relationships";
import type { RelationshipSignal } from "../github/issue-blocking-core";
import {
  compileChildCompletionDossier,
  evaluateChildCompletionEligibility,
  resolveChildCompletionLimits,
  selectBoundedChildren,
  type ChildCompletionChild,
  type ChildCompletionDossier,
  type ChildCompletionDossierLimits,
  type ChildCompletionPr,
} from "./core";

type ChildDossierResult = {
  ok: boolean;
  dossier: ChildCompletionDossier | null;
  text: string | null;
  diagnostics: string[];
  reason?: string;
};

type PullRequestPayload = {
  title?: string | null;
  body?: string | null;
  merged?: boolean | null;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  state?: string | null;
};

const DEFAULT_TIME_BUDGET_MS = 2_000;

function buildIssueUrl(issue: IssueRef): string {
  return `https://github.com/${issue.repo}/issues/${issue.number}`;
}

function buildCommitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function parsePullRequestUrl(prUrl: string): { repo: string; number: number } | null {
  try {
    const parsed = new URL(prUrl);
    if (!parsed.hostname.endsWith("github.com")) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, name, type, numberRaw] = parts;
    if (!owner || !name || type !== "pull") return null;
    const number = Number.parseInt(numberRaw, 10);
    if (!Number.isFinite(number) || number <= 0) return null;
    return { repo: `${owner}/${name}`, number };
  } catch {
    return null;
  }
}

function createDossierClient(repo: string): GitHubClient {
  return new GitHubClient(repo, {
    requestTimeoutMs: 1_200,
    sleepMs: async () => {},
  });
}

function normalizeError(error: unknown): string {
  if (!error) return "unknown error";
  const message = (error as any)?.message ?? String(error);
  return String(message).trim() || "unknown error";
}

function isRateLimitError(error: unknown): boolean {
  const err = error as GitHubApiError | undefined;
  if (!err) return false;
  return err.code === "rate_limit" || err.code === "auth";
}

export async function collectChildCompletionDossier(params: {
  parent: IssueRef;
  snapshot: IssueRelationshipSnapshot;
  signals: RelationshipSignal[];
  limits?: Partial<ChildCompletionDossierLimits>;
  timeBudgetMs?: number;
}): Promise<ChildDossierResult> {
  const diagnostics: string[] = [];
  const limits = resolveChildCompletionLimits(params.limits);
  const eligibility = evaluateChildCompletionEligibility({ snapshot: params.snapshot, signals: params.signals });

  if (eligibility.decision !== "eligible") {
    return { ok: true, dossier: null, text: null, diagnostics, reason: eligibility.reason };
  }

  const deadline = Date.now() + Math.max(200, Math.floor(params.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS));
  const hasBudget = () => Date.now() < deadline;
  const { selected, omitted } = selectBoundedChildren({ childIssues: eligibility.childIssues, maxChildren: limits.maxChildren });

  const clientCache = new Map<string, GitHubClient>();
  const getClient = (repo: string) => {
    const cached = clientCache.get(repo);
    if (cached) return cached;
    const client = createDossierClient(repo);
    clientCache.set(repo, client);
    return client;
  };

  const children: ChildCompletionChild[] = [];
  let incompleteReason: string | undefined;

  for (const child of selected) {
    if (!hasBudget()) {
      incompleteReason = "time budget exceeded";
      break;
    }

    const childUrl = buildIssueUrl(child);
    let title: string | null = null;
    let state: string | null = null;

    try {
      const issuePayload = await getClient(child.repo).getIssue(child.number);
      const issueData = issuePayload && typeof issuePayload === "object" ? (issuePayload as any) : {};
      title = typeof issueData.title === "string" ? issueData.title : null;
      state = typeof issueData.state === "string" ? issueData.state : null;
    } catch (error) {
      diagnostics.push(`- issue fetch failed for ${child.repo}#${child.number}: ${normalizeError(error)}`);
      if (isRateLimitError(error)) {
        incompleteReason = "rate-limited";
        break;
      }
    }

    const snapshotCandidates = listMergedPrCandidatesForIssue(child.repo, child.number).map(
      (row: { url: string }) => row.url
    );
    let prCandidates = snapshotCandidates.map((url) => normalizePrUrl(url)).filter(Boolean);

    if (prCandidates.length < limits.maxPrsPerChild && hasBudget()) {
      try {
        const searchResults = await searchMergedPullRequestsByIssueLink(child.repo, String(child.number));
        const searched = searchResults.map((row: { url: string }) => normalizePrUrl(row.url)).filter(Boolean);
        prCandidates = [...prCandidates, ...searched];
      } catch (error) {
        diagnostics.push(`- PR search failed for ${child.repo}#${child.number}: ${normalizeError(error)}`);
      }
    }

    const deduped = Array.from(new Set(prCandidates)).sort();
    const selectedPrs = deduped.slice(0, limits.maxPrsPerChild);

    const prs: ChildCompletionPr[] = [];
    for (const prUrl of selectedPrs) {
      if (!hasBudget()) {
        incompleteReason = "time budget exceeded";
        break;
      }
      const parsed = parsePullRequestUrl(prUrl);
      if (!parsed) {
        prs.push({ url: prUrl });
        continue;
      }

      let prTitle: string | null = null;
      let prBody: string | null = null;
      let merged: boolean | null = null;
      let mergeCommitUrl: string | null = null;

      try {
        const { owner, name } = splitRepoFullName(parsed.repo);
        const payload = await getClient(parsed.repo).request<PullRequestPayload>(
          `/repos/${owner}/${name}/pulls/${parsed.number}`
        );
        const prData = payload.data ?? {};
        prTitle = typeof prData.title === "string" ? prData.title : null;
        prBody = typeof prData.body === "string" ? prData.body : null;
        merged = prData.merged === true || Boolean(prData.merged_at);
        const mergeSha = typeof prData.merge_commit_sha === "string" ? prData.merge_commit_sha : null;
        if (mergeSha) {
          mergeCommitUrl = buildCommitUrl(parsed.repo, mergeSha);
        }
        if (merged) {
          recordPrSnapshot({ repo: child.repo, issue: `${child.repo}#${child.number}`, prUrl, state: PR_STATE_MERGED });
        }
      } catch (error) {
        diagnostics.push(`- PR fetch failed for ${prUrl}: ${normalizeError(error)}`);
        if (isRateLimitError(error)) {
          incompleteReason = "rate-limited";
          break;
        }
      }

      const excerpt = prBody ? truncateText(normalizeWhitespace(prBody), limits.maxExcerptChars) : null;
      prs.push({
        url: prUrl,
        title: prTitle,
        merged,
        mergeCommitUrl,
        bodyExcerpt: excerpt,
      });
    }

    children.push({
      issue: child,
      url: childUrl,
      title,
      state,
      prs,
    });

    if (incompleteReason) break;
  }

  const compiled = compileChildCompletionDossier({
    children,
    totalChildren: eligibility.childIssues.length,
    omittedChildren: omitted,
    incompleteReason,
    limits,
  });

  return { ok: true, dossier: compiled.dossier, text: compiled.text, diagnostics };
}
