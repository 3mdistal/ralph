import { $ } from "bun";

type GhCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type GhProcess = {
  quiet: () => Promise<GhCommandResult>;
};

type GhRunner = (strings: TemplateStringsArray, ...values: unknown[]) => GhProcess;

const gh: GhRunner = $ as unknown as GhRunner;

export type PullRequestView = {
  url: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  baseRefName?: string;
  headRefName?: string;
  isDraft?: boolean;
};

export type PullRequestSearchResult = {
  url: string;
  createdAt?: string;
  updatedAt?: string;
  number?: number;
};

export function normalizePrUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const match = trimmed.match(/^(https:\/\/)([^/]+)(\/.*)$/);
  if (!match) return trimmed;
  return `${match[1]}${match[2].toLowerCase()}${match[3]}`;
}

export async function viewPullRequest(repo: string, prUrl: string): Promise<PullRequestView | null> {
  const response = await gh`gh pr view ${prUrl} --repo ${repo} --json url,state,createdAt,updatedAt,baseRefName,headRefName,isDraft`.quiet();
  const data = JSON.parse(response.stdout.toString());
  if (!data?.url) return null;
  return {
    url: String(data.url),
    state: String(data.state ?? ""),
    createdAt: data.createdAt ? String(data.createdAt) : undefined,
    updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
    baseRefName: data.baseRefName ? String(data.baseRefName) : undefined,
    headRefName: data.headRefName ? String(data.headRefName) : undefined,
    isDraft: typeof data.isDraft === "boolean" ? data.isDraft : undefined,
  };
}

function parseSearchOutput(output: string): PullRequestSearchResult[] {
  const data = JSON.parse(output);
  if (!Array.isArray(data)) return [];
  const results: PullRequestSearchResult[] = [];
  for (const item of data) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!url) continue;
    results.push({
      url,
      createdAt: item?.createdAt ? String(item.createdAt) : undefined,
      updatedAt: item?.updatedAt ? String(item.updatedAt) : undefined,
      number: typeof item?.number === "number" ? item.number : undefined,
    });
  }
  return results;
}

async function runSearch(repo: string, search: string): Promise<PullRequestSearchResult[]> {
  const response = await gh`gh pr list --repo ${repo} --state open --search ${search} --json url,createdAt,updatedAt,number`.quiet();
  return parseSearchOutput(response.stdout.toString());
}

export async function searchOpenPullRequestsByIssueLink(
  repo: string,
  issueNumber: string
): Promise<PullRequestSearchResult[]> {
  const search = `fixes #${issueNumber} OR closes #${issueNumber}`;

  try {
    return await runSearch(repo, search);
  } catch {
    const fixes = await runSearch(repo, `fixes #${issueNumber}`);
    const closes = await runSearch(repo, `closes #${issueNumber}`);
    const seen = new Set<string>();
    const combined: PullRequestSearchResult[] = [];
    for (const entry of [...fixes, ...closes]) {
      const normalized = normalizePrUrl(entry.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      combined.push(entry);
    }
    return combined;
  }
}
