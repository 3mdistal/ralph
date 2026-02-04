import { GitHubApiError, GitHubClient } from "../github/client";
import { sanitizeEscalationReason } from "../github/escalation-writeback";
import { recordIssueSnapshot } from "../state";
import type { IssueMetadata } from "../escalation";

export async function getIssueMetadata(issue: string): Promise<IssueMetadata> {
  // issue format: "owner/repo#123"
  const match = issue.match(/^([^#]+)#(\d+)$/);
  if (!match) return { labels: [], title: "" };

  const [, repo, number] = match;
  try {
    const prefetchTimeoutMs = Number.isFinite(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS))
      ? Math.max(0, Math.floor(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS)))
      : 1_500;
    const github = new GitHubClient(repo, { requestTimeoutMs: prefetchTimeoutMs });
    const raw = await github.getIssue(Number(number));
    const data = raw && typeof raw === "object" ? (raw as any) : {};
    const metadata: IssueMetadata = {
      labels: Array.isArray(data.labels) ? data.labels.map((l: any) => l?.name ?? "").filter(Boolean) : [],
      title: typeof data.title === "string" ? data.title : "",
      state: typeof data.state === "string" ? data.state : undefined,
      stateReason: typeof data.state_reason === "string" ? data.state_reason : undefined,
      closedAt: typeof data.closed_at === "string" ? data.closed_at : undefined,
      url: typeof data.html_url === "string" ? data.html_url : undefined,
    };

    recordIssueSnapshot({
      repo,
      issue,
      title: metadata.title,
      state: metadata.state,
      url: metadata.url,
    });

    return metadata;
  } catch {
    return { labels: [], title: "" };
  }
}

export async function buildIssueContextForAgent(params: {
  repo: string;
  issueNumber: string | number;
}): Promise<string> {
  const repo = params.repo.trim();
  const issueNumber = Number(String(params.issueNumber).trim());

  const prefetchTimeoutMs = Number.isFinite(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS))
    ? Math.max(0, Math.floor(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS)))
    : 1_500;

  if (process.env.BUN_TEST || process.env.NODE_ENV === "test") {
    return `Issue context (prefetched)\nRepo: ${repo}\nIssue: #${issueNumber}\n\nIssue context prefetch skipped in tests`;
  }

  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    return `Issue context (prefetched)\nRepo: ${repo}\nIssue: ${String(params.issueNumber).trim()}\n\nIssue context unavailable: invalid issue number`;
  }

  const truncate = (input: string, maxChars: number): string => {
    const trimmed = String(input ?? "").trimEnd();
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  };

  try {
    const github = new GitHubClient(repo, { requestTimeoutMs: prefetchTimeoutMs });
    const rawIssue = await github.getIssue(issueNumber);
    const issue = rawIssue && typeof rawIssue === "object" ? (rawIssue as any) : {};
    const rawComments = await github.listIssueComments(issueNumber, { maxPages: 3, perPage: 100 });
    const comments = Array.isArray(rawComments) ? rawComments : [];

    const title = typeof issue.title === "string" ? issue.title : "";
    const url = typeof issue.html_url === "string" ? issue.html_url : "";
    const state = typeof issue.state === "string" ? issue.state : "";
    const stateReason = typeof issue.state_reason === "string" ? issue.state_reason : "";
    const labels = Array.isArray(issue.labels)
      ? issue.labels.map((l: any) => String(l?.name ?? "").trim()).filter(Boolean)
      : [];
    const body = typeof issue.body === "string" ? issue.body : "";

    const parsedComments = comments
      .map((c: any) => ({
        author: typeof c?.user?.login === "string" ? c.user.login : "unknown",
        createdAt: typeof c?.created_at === "string" ? c.created_at : "",
        url: typeof c?.html_url === "string" ? c.html_url : "",
        body: typeof c?.body === "string" ? c.body : "",
      }))
      .filter((c: any) => c.body || c.createdAt || c.author)
      .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const maxComments = 25;
    const recent = parsedComments.length > maxComments ? parsedComments.slice(-maxComments) : parsedComments;

    const headerLines = [
      "Issue context (prefetched)",
      `Repo: ${repo}`,
      `Issue: #${issueNumber}`,
      url ? `URL: ${url}` : null,
      title ? `Title: ${title}` : null,
      state ? `State: ${state}${stateReason ? ` (${stateReason})` : ""}` : null,
      `Labels: ${labels.length ? labels.join(", ") : "(none)"}`,
    ].filter(Boolean);

    const renderedBody = truncate(sanitizeEscalationReason(body), 12_000);

    const renderedComments = recent
      .map((c: any) => {
        const prefix = `- ${c.createdAt || ""} @${c.author}${c.url ? ` (${c.url})` : ""}`.trim();
        const text = truncate(sanitizeEscalationReason(c.body), 2_000);
        return [prefix, text ? text : "(empty)", ""].join("\n");
      })
      .join("\n");

    return [
      ...headerLines,
      "",
      "Body:",
      renderedBody || "(empty)",
      "",
      "Recent comments:",
      renderedComments || "(none)",
    ].join("\n");
  } catch (error: any) {
    if (error instanceof GitHubApiError) {
      const requestId = error.requestId ? ` requestId=${error.requestId}` : "";
      const resumeAt = error.resumeAtTs ? ` resumeAt=${new Date(error.resumeAtTs).toISOString()}` : "";
      return `Issue context (prefetched)\nRepo: ${repo}\nIssue: #${issueNumber}\n\nIssue context unavailable: ${error.code} HTTP ${error.status}${requestId}${resumeAt}\n${truncate(error.message, 800)}`;
    }
    return `Issue context (prefetched)\nRepo: ${repo}\nIssue: #${issueNumber}\n\nIssue context unavailable: ${truncate(error?.message ?? String(error), 800)}`;
  }
}
