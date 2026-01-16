import { $ } from "bun";
import { loadConfig, getRepoPath, getRepoBotBranch } from "./config";
import { ensureGhTokenEnv } from "./github-app-auth";
import { notifyRollupReady, notifyError } from "./notify";

type IssueRef = {
  number: number;
  raw: string;
};

type RollupPullRequest = {
  url: string;
  body: string;
};

const CLOSING_KEYWORDS = ["fixes", "closes", "resolves"];

export class RollupMonitor {
  private mergeCount: Map<string, number> = new Map();
  private mergedPRs: Map<string, string[]> = new Map();
  private batchSize: number;
  
  constructor(batchSize?: number) {
    this.batchSize = batchSize ?? loadConfig().batchSize;
  }
  
  /**
   * Record a successful merge to bot/integration
   */
  async recordMerge(repo: string, prUrl: string): Promise<void> {
    const count = (this.mergeCount.get(repo) || 0) + 1;
    this.mergeCount.set(repo, count);
    
    const prs = this.mergedPRs.get(repo) || [];
    prs.push(prUrl);
    this.mergedPRs.set(repo, prs);
    
    console.log(`[ralph:rollup:${repo}] Recorded merge for ${repo}: ${prUrl} (${count}/${this.batchSize})`);
    
    if (count >= this.batchSize) {
      await this.createRollupPR(repo);
    }
  }
  
  /**
   * Create a rollup PR from bot/integration to main
   */
  async createRollupPR(repo: string): Promise<string | null> {
    const repoPath = getRepoPath(repo);
    const botBranch = getRepoBotBranch(repo);
    const prs = this.mergedPRs.get(repo) || [];
    const logPrefix = `[ralph:rollup:${repo}]`;
    
    console.log(`${logPrefix} Creating rollup PR for ${repo}...`);
    
    try {
      await ensureGhTokenEnv();
      const existing = await this.findExistingRollupPR(repo, botBranch, repoPath, logPrefix);
      if (existing) {
        console.log(`${logPrefix} RALPH_ROLLUP_IDEMPOTENT existing=${existing.url}`);
        return existing.url;
      }

      const today = new Date().toISOString().split("T")[0];
      const issueRefs = await this.collectIssueRefs(repo, prs, repoPath, logPrefix);
      const body = this.buildRollupBody({
        botBranch,
        prs,
        issueRefs,
        generatedAt: new Date().toISOString(),
      });

      const result = await $`gh pr create --repo ${repo} --base main --head ${botBranch} --title "Rollup: ${today} batch (${prs.length} PRs)" --body ${body}`
        .cwd(repoPath)
        .quiet();

      const prUrl = result.stdout.toString().trim();
      console.log(`${logPrefix} Created rollup PR: ${prUrl}`);

      this.mergeCount.set(repo, 0);
      this.mergedPRs.set(repo, []);

      await notifyRollupReady(repo, prUrl, prs);

      return prUrl;
    } catch (e: any) {
      console.error(`${logPrefix} RALPH_ROLLUP_CREATE_FAILED`, e);
      const message = [e?.message ?? String(e), e?.stderr?.toString?.()].filter(Boolean).join("\n");
      await notifyError(`Creating rollup PR for ${repo}`, message);
      return null;
    }
  }
  
  private async findExistingRollupPR(
    repo: string,
    botBranch: string,
    repoPath: string,
    logPrefix: string
  ): Promise<RollupPullRequest | null> {
    try {
      const result = await $`gh pr list --repo ${repo} --state open --base main --head ${botBranch} --json url,body --limit 5`
        .cwd(repoPath)
        .quiet();
      const output = result.stdout.toString().trim();
      if (!output) {
        return null;
      }
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return null;
      }
      const match = parsed[0];
      if (!match?.url || !match?.body) {
        return null;
      }
      return { url: match.url, body: match.body };
    } catch (e: any) {
      console.warn(`${logPrefix} Failed to check existing rollup PRs`, e);
      return null;
    }
  }

  private async collectIssueRefs(
    repo: string,
    prs: string[],
    repoPath: string,
    logPrefix: string
  ): Promise<IssueRef[]> {
    const refs = new Map<number, IssueRef>();
    for (const pr of prs) {
      const issueRefs = await this.extractIssueRefsFromPr(repo, pr, repoPath, logPrefix);
      for (const ref of issueRefs) {
        refs.set(ref.number, ref);
      }
    }
    return [...refs.values()].sort((a, b) => a.number - b.number);
  }

  private async extractIssueRefsFromPr(
    repo: string,
    pr: string,
    repoPath: string,
    logPrefix: string
  ): Promise<IssueRef[]> {
    try {
      const result = await $`gh pr view --repo ${repo} ${pr} --json body`
        .cwd(repoPath)
        .quiet();
      const output = result.stdout.toString().trim();
      if (!output) {
        return [];
      }
      const parsed = JSON.parse(output);
      const body = typeof parsed?.body === "string" ? parsed.body : "";
      return this.parseIssueRefs(body);
    } catch (e: any) {
      console.warn(`${logPrefix} Failed to read PR body for issue refs (${pr})`, e);
      return [];
    }
  }

  private parseIssueRefs(body: string): IssueRef[] {
    const regex = new RegExp(`(?:${CLOSING_KEYWORDS.join("|")})\\s+#(\\d+)`, "gi");
    const refs = new Map<number, IssueRef>();
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(body)) !== null) {
      const number = Number(match[1]);
      if (!Number.isNaN(number)) {
        refs.set(number, { number, raw: match[0] });
      }
    }
    return [...refs.values()];
  }

  private buildRollupBody(params: {
    botBranch: string;
    prs: string[];
    issueRefs: IssueRef[];
    generatedAt: string;
  }): string {
    const prList = params.prs.map(pr => `- ${pr}`).join("\n");
    const issueList = params.issueRefs.length > 0
      ? params.issueRefs.map(ref => `- #${ref.number}`).join("\n")
      : "- (none detected)";
    const closingLines = params.issueRefs.map(ref => `Closes #${ref.number}`).join("\n");

    return `${closingLines}

## Summary

This PR consolidates ${params.prs.length} changes from the \`${params.botBranch}\` branch.

## Included PRs

${prList}

## Included Issues

${issueList}

## Testing

Please test the following areas affected by these changes:
- Run the full test suite: \`bun test\`
- Manually verify any UI changes
- Check for regressions in core functionality

---
Generated by Ralph Loop at ${params.generatedAt}`.trim();
  }

  /**
   * Force a rollup for a specific repo (manual trigger)
   */
  async forceRollup(repo: string): Promise<string | null> {
    const count = this.mergeCount.get(repo) || 0;
    if (count === 0) {
      console.log(`[ralph:rollup:${repo}] No merges to roll up for ${repo}`);
      return null;
    }
    
    return this.createRollupPR(repo);
  }

  /**
   * Get current status
   */
  getStatus(): Map<string, { count: number; prs: string[] }> {
    const status = new Map<string, { count: number; prs: string[] }>();
    
    for (const [repo, count] of this.mergeCount) {
      status.set(repo, {
        count,
        prs: this.mergedPRs.get(repo) || [],
      });
    }
    
    return status;
  }
}
