import { $ } from "bun";
import { loadConfig, getRepoPath, getRepoBotBranch } from "./config";
import { ensureGhTokenEnv } from "./github-app-auth";
import { notifyRollupReady, notifyError } from "./notify";
import {
  createNewRollupBatch,
  getOrCreateRollupBatch,
  listOpenRollupBatches,
  listRollupBatchEntries,
  loadRollupBatchById,
  markRollupBatchRolledUp,
  recordRollupMerge,
} from "./state";

export class RollupMonitor {
  private mergeCount: Map<string, number> = new Map();
  private mergedPRs: Map<string, string[]> = new Map();
  private batchSize: number;

  constructor(batchSize?: number) {
    this.batchSize = batchSize ?? loadConfig().batchSize;
    this.rehydrateFromState();
  }

  private rehydrateFromState(): void {
    const batches = listOpenRollupBatches();

    for (const batch of batches) {
      const entries = listRollupBatchEntries(batch.id);
      this.mergeCount.set(batch.repo, entries.length);
      this.mergedPRs.set(batch.repo, entries.map((entry) => entry.prUrl));
    }
  }

  /**
   * Record a successful merge to bot/integration
   */
  async recordMerge(repo: string, prUrl: string): Promise<void> {
    const botBranch = getRepoBotBranch(repo);
    const snapshot = recordRollupMerge({
      repo,
      botBranch,
      batchSize: this.batchSize,
      prUrl,
    });

    const count = snapshot.entries.length;
    this.mergeCount.set(repo, count);
    this.mergedPRs.set(repo, snapshot.entries.map((entry) => entry.prUrl));

    if (!snapshot.entryInserted) {
      console.log(`[ralph:rollup] Duplicate merge ignored for ${repo}: ${prUrl}`);
      return;
    }

    console.log(`[ralph:rollup] Recorded merge for ${repo}: ${prUrl} (${count}/${this.batchSize})`);

    if (count >= this.batchSize) {
      await this.createRollupPR(repo, snapshot.batch.id);
    }
  }
  
  private async ensureRollupPrRecorded(params: {
    repo: string;
    botBranch: string;
    batchId: string;
  }): Promise<{ prUrl: string; prNumber?: number | null } | null> {
    const batch = loadRollupBatchById(params.batchId);
    if (batch?.rollupPrUrl) {
      return { prUrl: batch.rollupPrUrl, prNumber: batch.rollupPrNumber ?? null };
    }

    await ensureGhTokenEnv();
    const search = `Ralph-Rollup-Batch: ${params.batchId}`;

    try {
      const result = await $`gh pr list --repo ${params.repo} --base main --search ${search} --state open --json url,number`.quiet();
      const rows = JSON.parse(result.stdout.toString() || "[]") as Array<{ url?: string; number?: number }>;

      if (rows.length > 0 && rows[0]?.url) {
        markRollupBatchRolledUp({
          batchId: params.batchId,
          rollupPrUrl: rows[0].url,
          rollupPrNumber: rows[0].number ?? null,
        });
        return { prUrl: rows[0].url, prNumber: rows[0].number ?? null };
      }
    } catch (e: any) {
      console.error(`[ralph:rollup] Failed to query existing rollup for ${params.repo} (${params.batchId}):`, e);
      await notifyError(`Querying rollup PR for ${params.repo} (${params.batchId})`, e.message);
    }

    return null;
  }

  /**
   * Create a rollup PR from bot/integration to main
   */
  async createRollupPR(repo: string, batchId?: string): Promise<string | null> {
    const repoPath = getRepoPath(repo);
    const botBranch = getRepoBotBranch(repo);
    const batch = batchId
      ? loadRollupBatchById(batchId)
      : getOrCreateRollupBatch({ repo, botBranch, batchSize: this.batchSize });

    if (!batch) {
      console.error(`[ralph:rollup] No rollup batch found for ${repo}`);
      await notifyError(`Creating rollup PR for ${repo}`, "No rollup batch found");
      return null;
    }

    const entries = listRollupBatchEntries(batch.id);
    const prs = entries.map((entry) => entry.prUrl);

    if (prs.length === 0) {
      console.log(`[ralph:rollup] No merges to roll up for ${repo}`);
      return null;
    }

    const existing = await this.ensureRollupPrRecorded({ repo, botBranch, batchId: batch.id });
    if (existing) {
      console.log(`[ralph:rollup] Rollup PR already exists for ${repo} (${batch.id}): ${existing.prUrl}`);
      this.mergeCount.set(repo, 0);
      this.mergedPRs.set(repo, []);
      createNewRollupBatch({ repo, botBranch, batchSize: batch.batchSize });
      return existing.prUrl;
    }

    console.log(`[ralph:rollup] Creating rollup PR for ${repo} (${batch.id})...`);

    try {
      // Build PR body
      const today = new Date().toISOString().split("T")[0];
      const prList = prs.map((pr) => `- ${pr}`).join("\n");

      const body = `## Rollup: ${today} batch

This PR consolidates ${prs.length} changes from the \`${botBranch}\` branch.

### Included PRs

${prList}

### Testing

Please test the following areas affected by these changes:
- Run the full test suite: \`bun test\`
- Manually verify any UI changes
- Check for regressions in core functionality

### Review Notes

This is an automated rollup created by Ralph Loop. Each individual PR was reviewed by @product and @devex agents before merging to \`${botBranch}\`.

Ralph-Rollup-Batch: ${batch.id}

---
*Generated by Ralph Loop at ${new Date().toISOString()}*`;

      // Create the PR
      await ensureGhTokenEnv();
      const result = await $`gh pr create --repo ${repo} --base main --head ${botBranch} --title "Rollup: ${today} batch (${prs.length} PRs)" --body ${body}`.cwd(repoPath).quiet();

      const prUrl = result.stdout.toString().trim();
      console.log(`[ralph:rollup] Created rollup PR: ${prUrl}`);

      const prNumber = prUrl.match(/\/pull\/(\d+)(?:$|\?)/)?.[1];

      markRollupBatchRolledUp({
        batchId: batch.id,
        rollupPrUrl: prUrl,
        rollupPrNumber: prNumber ? Number(prNumber) : null,
      });

      this.mergeCount.set(repo, 0);
      this.mergedPRs.set(repo, []);
      createNewRollupBatch({ repo, botBranch, batchSize: batch.batchSize });

      await notifyRollupReady(repo, prUrl, prs);

      return prUrl;
    } catch (e: any) {
      console.error(`[ralph:rollup] Failed to create rollup PR for ${repo} (${batch.id}):`, e);
      await notifyError(`Creating rollup PR for ${repo} (${batch.id})`, e.message);
      return null;
    }
  }
  
  /**
   * Force a rollup for a specific repo (manual trigger)
   */
  async forceRollup(repo: string): Promise<string | null> {
    const count = this.mergeCount.get(repo) || 0;
    if (count === 0) {
      console.log(`[ralph:rollup] No merges to roll up for ${repo}`);
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
