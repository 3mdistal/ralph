import { normalizePrUrl, searchMergedPullRequestsByIssueLink, viewPullRequestMergeCommit } from "../github/pr";
import type { IssueRef } from "../github/issue-ref";
import { PR_STATE_MERGED, listMergedPrCandidatesForIssue, recordPrSnapshot } from "../state";
import type { ParentVerificationEvidence } from "./core";

type EvidenceResult = {
  childIssues: IssueRef[];
  evidence: ParentVerificationEvidence[];
  diagnostics: string[];
};

const MAX_PRS_PER_CHILD = 3;
const MAX_EVIDENCE_TOTAL = 200;

function buildIssueUrl(issue: IssueRef): string {
  return `https://github.com/${issue.repo}/issues/${issue.number}`;
}

function buildCommitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

function dedupeOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizePrUrl(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function sortIssues(issues: IssueRef[]): IssueRef[] {
  return [...issues].sort((a, b) => {
    const repoCompare = a.repo.localeCompare(b.repo);
    if (repoCompare !== 0) return repoCompare;
    return a.number - b.number;
  });
}

export async function collectParentVerificationEvidence(params: {
  childIssues: IssueRef[];
}): Promise<EvidenceResult> {
  const childIssues = sortIssues(params.childIssues);
  const evidence: ParentVerificationEvidence[] = [];
  const diagnostics: string[] = [];

  for (const issue of childIssues) {
    evidence.push({ kind: "issue", url: buildIssueUrl(issue), label: "Issue" });
    if (evidence.length >= MAX_EVIDENCE_TOTAL) break;

    const snapshotCandidates = listMergedPrCandidatesForIssue(issue.repo, issue.number).map(
      (row: { url: string }) => row.url
    );
    let searchCandidates: string[] = [];
    try {
      const searchResults = await searchMergedPullRequestsByIssueLink(issue.repo, String(issue.number));
      searchCandidates = searchResults.map((row: { url: string }) => row.url);
    } catch (error: any) {
      diagnostics.push(
        `- Failed to search merged PRs for ${issue.repo}#${issue.number}: ${error?.message ?? String(error)}`
      );
    }

    const prCandidates = dedupeOrdered([...snapshotCandidates, ...searchCandidates])
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_PRS_PER_CHILD);
    for (const prUrl of prCandidates) {
      evidence.push({ kind: "pr", url: prUrl, label: "PR" });
      recordPrSnapshot({ repo: issue.repo, issue: `${issue.repo}#${issue.number}`, prUrl, state: PR_STATE_MERGED });
      if (evidence.length >= MAX_EVIDENCE_TOTAL) break;

      try {
        const mergeCommit = await viewPullRequestMergeCommit(issue.repo, prUrl);
        if (mergeCommit?.sha) {
          evidence.push({ kind: "commit", url: buildCommitUrl(issue.repo, mergeCommit.sha), label: "Commit" });
        }
      } catch (error: any) {
        diagnostics.push(`- Failed to read merge commit for ${prUrl}: ${error?.message ?? String(error)}`);
      }

      if (evidence.length >= MAX_EVIDENCE_TOTAL) break;
    }
  }

  return { childIssues, evidence, diagnostics };
}
