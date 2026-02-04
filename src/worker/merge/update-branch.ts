import { createGhRunner } from "../../github/gh-runner";

function shouldFallbackToWorktreeUpdate(message: string): boolean {
  const lowered = message.toLowerCase();
  if (!lowered) return false;
  if (lowered.includes("unknown command")) return true;
  if (lowered.includes("not a known command")) return true;
  if (lowered.includes("could not resolve to a pull request")) return true;
  if (lowered.includes("requires a github enterprise")) return true;
  if (lowered.includes("not supported")) return true;
  return false;
}

export async function updatePullRequestBranch(params: {
  repo: string;
  prUrl: string;
  cwd: string;
  formatGhError: (error: unknown) => string;
  updateViaWorktree: (prUrl: string) => Promise<void>;
}): Promise<void> {
  const ghWrite = createGhRunner({ repo: params.repo, mode: "write" });

  try {
    await ghWrite`gh pr update-branch ${params.prUrl} --repo ${params.repo}`.cwd(params.cwd).quiet();
    return;
  } catch (error: any) {
    const message = params.formatGhError(error);
    if (!shouldFallbackToWorktreeUpdate(message)) throw error;
  }

  await params.updateViaWorktree(params.prUrl);
}
