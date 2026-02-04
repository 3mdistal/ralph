import { splitRepoFullName } from "../../github/client";

import { extractPullRequestNumber } from "../lanes/required-checks";

export async function getPullRequestFiles(params: {
  repo: string;
  prUrl: string;
  githubApiRequest: <T>(path: string) => Promise<T | null>;
}): Promise<string[]> {
  const prNumber = extractPullRequestNumber(params.prUrl);
  if (!prNumber) {
    throw new Error(`Could not parse pull request number from URL: ${params.prUrl}`);
  }

  const { owner, name } = splitRepoFullName(params.repo);
  const files: string[] = [];
  let page = 1;

  while (true) {
    const payload = await params.githubApiRequest<Array<{ filename?: string | null }>>(
      `/repos/${owner}/${name}/pulls/${prNumber}/files?per_page=100&page=${page}`
    );

    if (!payload || payload.length === 0) break;

    for (const entry of payload) {
      const filename = String(entry?.filename ?? "").trim();
      if (filename) files.push(filename);
    }

    if (payload.length < 100) break;
    page += 1;
  }

  return files;
}
