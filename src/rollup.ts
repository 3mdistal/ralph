import { $ } from "bun";

import {
  getConfig,
  getRepoPath,
  getRepoBotBranch,
  getRepoRollupBatchSize,
  getRepoPreflightCommands,
  getRepoRequiredChecksOverride,
  getRepoVerificationConfig,
} from "./config";
import { createGhRunner } from "./github/gh-runner";
import { resolveRequiredChecks, type BranchProtection, type ResolvedRequiredChecks } from "./github/required-checks";
import { notifyRollupReady, notifyError } from "./notify";
import {
  createNewRollupBatch,
  getOrCreateRollupBatch,
  listOpenRollupBatches,
  listRollupBatchEntries,
  loadRollupBatchById,
  markRollupBatchRolledUp,
  deleteIdempotencyKey,
  getIdempotencyRecord,
  recordIdempotencyKey,
  recordRollupMerge,
  updateRollupBatchEntryIssueRefs,
} from "./state";

type NormalizedIssueRef = {
  owner: string;
  repo: string;
  number: number;
  raw: string;
};

type RollupPullRequest = {
  url: string;
  body: string;
};

type ClosingIssueOptions = {
  today: string;
  botBranch: string;
  prs: string[];
  includedIssues: string[];
  closingIssues: string[];
  verification: RollupVerificationData;
  batchId: string;
  generatedAt: string;
};

type RepoVerificationScenario = {
  title?: string;
  steps: string[];
};

type RepoVerificationStaging = {
  url: string;
  expected?: string;
};

type RollupVerificationData = {
  baseBranch: string;
  requiredChecks: ResolvedRequiredChecks;
  preflight: string[];
  e2e: RepoVerificationScenario[];
  staging: RepoVerificationStaging[];
  manualChecks: string[];
};

const ghRead = (repo: string) => createGhRunner({ repo, mode: "read" });
const ghWrite = (repo: string) => createGhRunner({ repo, mode: "write" });

const CLOSING_KEYWORDS = [
  "fix",
  "fixes",
  "fixed",
  "close",
  "closes",
  "closed",
  "resolve",
  "resolves",
  "resolved",
];

const ROLLUP_CREATE_LEASE_TTL_MS = 10 * 60 * 1000;
const MANUAL_CHECKS_MARKER_START = "<!-- ralph:manual-checks:start -->";
const MANUAL_CHECKS_MARKER_END = "<!-- ralph:manual-checks:end -->";
const MAX_E2E_BULLETS = 8;
const MAX_PREFLIGHT_COMMANDS = 6;
const MAX_STAGING_ITEMS = 5;

function parseRepoFullName(repo: string): { owner: string; repo: string } | null {
  const parts = repo.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0]!, repo: parts[1]! };
}

function parseIssueNumberFromRef(issueRef: string): number | null {
  const match = issueRef.match(/#(\d+)$/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function makeRollupBatchMarker(batchId: string): {
  visibleLine: string;
  token: string;
  hiddenLine: string;
  searchQuery: string;
} {
  const token = `ralph-rollup-batch-id=${batchId}`;
  return {
    visibleLine: `Ralph-Rollup-Batch: ${batchId}`,
    token,
    hiddenLine: `<!-- ${token} -->`,
    searchQuery: `in:body ${token}`,
  };
}

function isLikelyRalphRollupBody(body: string): boolean {
  const normalized = body.toLowerCase();
  if (normalized.includes("this is an automated rollup created by ralph loop")) return true;
  if (normalized.includes("## rollup:")) return true;
  return false;
}

function parseClosingIssueRefs(body: string, currentRepo: string): NormalizedIssueRef[] {
  const current = parseRepoFullName(currentRepo);
  if (!current) return [];

  const regex = new RegExp(
    `\\b(?:${CLOSING_KEYWORDS.join("|")})\\b\\s*[:\\-]?\\s*(?:\\(|\\[)?\\s*(?:([A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+))?\\s*#(\\d+)`,
    "gi"
  );

  const refs = new Map<number, NormalizedIssueRef>();

  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(body)) !== null) {
    const repoPart = match[1]?.trim() ?? "";
    const number = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isNaN(number)) {
      const resolved = repoPart ? parseRepoFullName(repoPart) : current;
      if (!resolved) continue;
      if (`${resolved.owner}/${resolved.repo}` !== currentRepo) continue;

      refs.set(number, {
        owner: resolved.owner,
        repo: resolved.repo,
        number,
        raw: match[0],
      });
    }
  }

  return [...refs.values()].sort((a, b) => a.number - b.number);
}

function extractClosingIssuesFromBody(body: string, currentRepo: string): string[] {
  return parseClosingIssueRefs(body, currentRepo).map((ref) => `${ref.owner}/${ref.repo}#${ref.number}`);
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

function normalizeManualCheckLines(section: string): string[] {
  const lines = splitLines(section);
  const bullets: string[] = [];
  const fallback: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bulletMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (bulletMatch?.[1]) {
      bullets.push(bulletMatch[1].trim());
    } else {
      fallback.push(trimmed);
    }
  }

  const items = bullets.length > 0 ? bullets : fallback;
  return items.map((item) => item.trim()).filter(Boolean);
}

function extractManualChecksFromMarkers(body: string): string | null {
  const lower = body.toLowerCase();
  const startToken = MANUAL_CHECKS_MARKER_START.toLowerCase();
  const endToken = MANUAL_CHECKS_MARKER_END.toLowerCase();
  const startIdx = lower.indexOf(startToken);
  if (startIdx === -1) return null;
  const endIdx = lower.indexOf(endToken, startIdx + startToken.length);
  if (endIdx === -1) return null;
  return body.slice(startIdx + startToken.length, endIdx);
}

function extractManualChecksFromHeading(body: string): string | null {
  const lines = splitLines(body);
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let collecting = false;
  let headingLevel = 0;
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? "";
      const nextChar = fence[0] === "~" ? "~" : "`";
      if (!inFence) {
        inFence = true;
        fenceChar = nextChar;
      } else if (fenceChar === nextChar) {
        inFence = false;
        fenceChar = null;
      }
      if (collecting) collected.push(line);
      continue;
    }

    if (!collecting && !inFence) {
      const headingMatch = trimmed.match(/^(#{1,6})\s+manual checks\b/i);
      if (headingMatch) {
        collecting = true;
        headingLevel = headingMatch[1].length;
        continue;
      }
    }

    if (collecting && !inFence) {
      const headingMatch = trimmed.match(/^(#{1,6})\s+/);
      if (headingMatch) {
        const nextLevel = headingMatch[1].length;
        if (nextLevel <= headingLevel) break;
      }
    }

    if (collecting) collected.push(line);
  }

  if (!collecting) return null;
  return collected.join("\n");
}

function extractManualChecksFromBody(body: string): string[] {
  const normalized = body.replace(/\r\n/g, "\n");
  const markerSection = extractManualChecksFromMarkers(normalized);
  if (markerSection !== null) {
    return normalizeManualCheckLines(markerSection);
  }

  const headingSection = extractManualChecksFromHeading(normalized);
  if (headingSection !== null) {
    return normalizeManualCheckLines(headingSection);
  }

  return [];
}

function formatScenarioSteps(scenario: RepoVerificationScenario): string | null {
  const steps = scenario.steps.map((step) => step.trim()).filter(Boolean);
  if (steps.length === 0) return null;
  const title = scenario.title?.trim();
  if (title) return `${title}: ${steps.join("; ")}`;
  return steps.join("; ");
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function buildVerificationSections(verification: RollupVerificationData): string[] {
  const lines: string[] = [];

  lines.push("### CI (already covered)", "");
  const requiredChecks = verification.requiredChecks.checks;
  if (requiredChecks.length > 0) {
    const source = verification.requiredChecks.source;
    const sourceNote =
      source === "config"
        ? " (from config)"
        : source === "protection"
          ? ` (from branch protection on \`${verification.requiredChecks.branch ?? verification.baseBranch}\`)`
          : "";
    lines.push(`- Required checks${sourceNote}: ${requiredChecks.map((check) => `\`${check}\``).join(", ")}`);
  } else {
    lines.push("- Required checks: (none or unavailable)");
  }
  lines.push("- Status: must be green before merge.", "");

  lines.push("### Quick sanity (optional)", "");
  const preflight = verification.preflight.slice(0, MAX_PREFLIGHT_COMMANDS);
  if (preflight.length > 0) {
    lines.push(...preflight.map((cmd) => `- \`${cmd}\``));
  } else {
    lines.push("- (none configured)");
  }
  lines.push("");

  lines.push("### E2E verification (human)", "");
  const repoE2E = verification.e2e
    .map((scenario) => formatScenarioSteps(scenario))
    .filter((value): value is string => Boolean(value));
  const combined = dedupePreserveOrder([...repoE2E, ...verification.manualChecks]).slice(0, MAX_E2E_BULLETS);
  if (combined.length > 0) {
    lines.push(...combined.map((item) => `- ${item}`));
  } else {
    lines.push("- No repo E2E plan configured; consider adding repos[].verification.e2e.");
  }
  lines.push("");

  lines.push("### Staging / preview (optional)", "");
  const staging = verification.staging.slice(0, MAX_STAGING_ITEMS);
  if (staging.length > 0) {
    lines.push(
      ...staging.map((item) =>
        item.expected ? `- ${item.url} — ${item.expected}` : `- ${item.url}`
      )
    );
  } else {
    lines.push("- (none configured)");
  }
  lines.push("");

  return lines;
}

function buildRollupBody(options: ClosingIssueOptions): string {
  const prList = options.prs.map((pr) => `- ${pr}`).join("\n") || "- (none)";
  const issueList = options.includedIssues.map((issue) => `- ${issue}`).join("\n") || "- (none)";
  const marker = makeRollupBatchMarker(options.batchId);
  const lines: string[] = [
    `## Rollup: ${options.today} batch`,
    "",
    `This PR consolidates ${options.prs.length} changes from the \`${options.botBranch}\` branch.`,
    "",
    "### Included PRs",
    "",
    prList,
    "",
    "### Included Issues",
    "",
    issueList,
    "",
  ];

  if (options.closingIssues.length > 0) {
    lines.push("### Closes", "", ...options.closingIssues.map((issue) => `Closes ${issue}`), "");
  }

  lines.push(
    ...buildVerificationSections(options.verification),
    "### Review Notes",
    "",
    `This is an automated rollup created by Ralph Loop. Each individual PR was reviewed by @product and @devex agents before merging to \`${options.botBranch}\`.`,
    "",
    "---",
    marker.visibleLine,
    marker.token,
    marker.hiddenLine,
    "",
    "---",
    `*Generated by Ralph Loop at ${options.generatedAt}*`
  );

  return lines.join("\n");
}

export function __extractClosingIssuesFromBodyForTests(body: string): string[] {
  return extractClosingIssuesFromBody(body, "acme/widgets");
}

export function __extractManualChecksFromBodyForTests(body: string): string[] {
  return extractManualChecksFromBody(body);
}

export function __buildRollupBodyForTests(options: ClosingIssueOptions): string {
  return buildRollupBody(options);
}

type RollupRecordedResult =
  | { kind: "exists"; prUrl: string; prNumber?: number | null }
  | { kind: "missing" }
  | { kind: "unknown"; error: string };

function tryAcquireRollupCreateLease(lockKey: string): boolean {
  const inserted = recordIdempotencyKey({ key: lockKey, scope: "rollup:create" });
  if (inserted) return true;

  const record = getIdempotencyRecord(lockKey);
  if (!record?.createdAt) return false;
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;

  const ageMs = Date.now() - createdAtMs;
  if (ageMs <= ROLLUP_CREATE_LEASE_TTL_MS) return false;

  deleteIdempotencyKey(lockKey);
  return recordIdempotencyKey({ key: lockKey, scope: "rollup:create" });
}

export class RollupMonitor {
  private mergeCount: Map<string, number> = new Map();
  private mergedPRs: Map<string, string[]> = new Map();
  private repoKeys: Map<string, string> = new Map();
  private perRepoBatchSize: Map<string, number> = new Map();
  private batchSize: number;

  constructor(batchSize?: number) {
    this.batchSize = batchSize ?? getConfig().batchSize;
    this.rehydrateFromState();
  }

  private rehydrateFromState(): void {
    const batches = listOpenRollupBatches();

    for (const batch of batches) {
      const entries = listRollupBatchEntries(batch.id);
      const key = this.getRepoKey(batch.repo, batch.botBranch);
      this.mergeCount.set(key, entries.length);
      this.mergedPRs.set(key, entries.map((entry) => entry.prUrl));
      this.repoKeys.set(batch.repo, key);
      this.perRepoBatchSize.set(batch.repo, batch.batchSize);
    }
  }

  private getBatchSize(repo: string): number {
    const cached = this.perRepoBatchSize.get(repo);
    if (cached) return cached;
    const size = getRepoRollupBatchSize(repo, this.batchSize);
    this.perRepoBatchSize.set(repo, size);
    return size;
  }

  private getRepoKey(repo: string, botBranch: string): string {
    return `${repo}::${botBranch}`;
  }

  private getRepoKeyForRepo(repo: string, botBranch: string): string {
    return this.repoKeys.get(repo) ?? this.getRepoKey(repo, botBranch);
  }

  /**
   * Record a successful merge to bot/integration
   */
  async recordMerge(repo: string, prUrl: string): Promise<void> {
    const botBranch = getRepoBotBranch(repo);
    const batchSize = this.getBatchSize(repo);
    const repoPath = getRepoPath(repo);

    const issueRefs: string[] = [];
    const snapshot = recordRollupMerge({
      repo,
      botBranch,
      batchSize,
      prUrl,
      issueRefs,
    });

    const key = this.getRepoKeyForRepo(repo, botBranch);
    const count = snapshot.entries.length;
    this.mergeCount.set(key, count);
    this.mergedPRs.set(key, snapshot.entries.map((entry) => entry.prUrl));
    this.repoKeys.set(repo, key);

    if (!snapshot.entryInserted) {
      console.log(`[ralph:rollup] Duplicate merge ignored for ${repo}: ${prUrl}`);
      return;
    }

    console.log(`[ralph:rollup] Recorded merge for ${repo}: ${prUrl} (${count}/${snapshot.batch.batchSize})`);

    if (count >= snapshot.batch.batchSize) {
      await this.createRollupPR(repo, snapshot.batch.id);
    }
  }

  private async ensureRollupPrRecorded(params: {
    repo: string;
    botBranch: string;
    baseBranch: string;
    batchId: string;
    repoPath: string;
    logPrefix: string;
  }): Promise<RollupRecordedResult> {
    const batch = loadRollupBatchById(params.batchId);
    if (batch?.rollupPrUrl) {
      return { kind: "exists", prUrl: batch.rollupPrUrl, prNumber: batch.rollupPrNumber ?? null };
    }

    const marker = makeRollupBatchMarker(params.batchId);
    const search = marker.searchQuery;

    try {
      const result = await ghRead(params.repo)`gh pr list --repo ${params.repo} --base ${params.baseBranch} --search ${search} --state all --json url,number`.quiet();
      const rows = JSON.parse(result.stdout.toString() || "[]") as Array<{ url?: string; number?: number }>;

      if (rows.length > 0 && rows[0]?.url) {
        markRollupBatchRolledUp({
          batchId: params.batchId,
          rollupPrUrl: rows[0].url,
          rollupPrNumber: rows[0].number ?? null,
        });
        return { kind: "exists", prUrl: rows[0].url, prNumber: rows[0].number ?? null };
      }

      const open = await this.findExistingRollupPR(
        params.repo,
        params.botBranch,
        params.baseBranch,
        params.repoPath,
        params.logPrefix
      );
      if (open && open.body.includes(marker.token)) {
        const prNumber = open.url.match(/\/pull\/(\d+)(?:$|\?)/)?.[1];
        markRollupBatchRolledUp({
          batchId: params.batchId,
          rollupPrUrl: open.url,
          rollupPrNumber: prNumber ? Number(prNumber) : null,
        });
        return { kind: "exists", prUrl: open.url, prNumber: prNumber ? Number(prNumber) : null };
      }

      if (open && isLikelyRalphRollupBody(open.body)) {
        return {
          kind: "unknown",
          error: `Open rollup PR exists without batch marker; refusing to associate batch ${params.batchId} to ${open.url}`,
        };
      }
    } catch (e: any) {
      console.error(`[ralph:rollup] Failed to query existing rollup for ${params.repo} (${params.batchId}):`, e);
      await notifyError(`Querying rollup PR for ${params.repo} (${params.batchId})`, e.message, { repo: params.repo });
      return { kind: "unknown", error: e?.message ?? String(e) };
    }

    return { kind: "missing" };
  }

  /**
   * Create a rollup PR from bot/integration to the repo default branch
   */
  async createRollupPR(repo: string, batchId?: string): Promise<string | null> {
    const repoPath = getRepoPath(repo);
    const botBranch = getRepoBotBranch(repo);
    const logPrefix = `[ralph:rollup:${repo}]`;
    const baseBranch = await this.resolveRollupBaseBranch(repo, repoPath, logPrefix);
    const batch = batchId
      ? loadRollupBatchById(batchId)
      : getOrCreateRollupBatch({ repo, botBranch, batchSize: this.getBatchSize(repo) });

    if (!batch) {
      console.error(`[ralph:rollup] No rollup batch found for ${repo}`);
      await notifyError(`Creating rollup PR for ${repo}`, "No rollup batch found", { repo });
      return null;
    }

    const entries = listRollupBatchEntries(batch.id);
    const prs = entries.map((entry) => entry.prUrl);

    if (prs.length === 0) {
      console.log(`[ralph:rollup] No merges to roll up for ${repo}`);
      return null;
    }

    const existing = await this.ensureRollupPrRecorded({
      repo,
      botBranch,
      batchId: batch.id,
      repoPath,
      logPrefix,
      baseBranch,
    });

    if (existing.kind === "unknown") {
      console.error(`[ralph:rollup] Unable to verify existing rollup PR for ${repo} (${batch.id}); aborting creation.`);
      await notifyError(`Creating rollup PR for ${repo} (${batch.id})`, existing.error, { repo });
      return null;
    }

    if (existing.kind === "exists") {
      console.log(`[ralph:rollup] Rollup PR already exists for ${repo} (${batch.id}): ${existing.prUrl}`);
      const key = this.getRepoKeyForRepo(repo, botBranch);
      this.mergeCount.set(key, 0);
      this.mergedPRs.set(key, []);
      createNewRollupBatch({ repo, botBranch, batchSize: batch.batchSize });
      return existing.prUrl;
    }

    console.log(`[ralph:rollup] Creating rollup PR for ${repo} (${batch.id})...`);

    const lockKey = `rollup:create:${repo}:${batch.id}`;
    let leaseAcquired = false;

    try {
      leaseAcquired = tryAcquireRollupCreateLease(lockKey);
      if (!leaseAcquired) {
        console.warn(`[ralph:rollup] Rollup creation already in progress for ${repo} (${batch.id}); skipping duplicate.`);
        const check = await this.ensureRollupPrRecorded({
          repo,
          botBranch,
          batchId: batch.id,
          repoPath,
          logPrefix,
          baseBranch,
        });
        return check.kind === "exists" ? check.prUrl : null;
      }

      const today = new Date().toISOString().split("T")[0];
      const { issueRefs, manualChecks } = await this.collectRollupVerificationData(
        repo,
        batch.id,
        entries,
        repoPath,
        logPrefix
      );
      const includedIssues = issueRefs;
      const closingIssues = issueRefs;
      const verificationConfig = getRepoVerificationConfig(repo);
      const preflightConfig = getRepoPreflightCommands(repo);
      const requiredChecks = await this.resolveRollupRequiredChecks(repo, repoPath, baseBranch, logPrefix);

      const body = buildRollupBody({
        today,
        botBranch,
        prs,
        includedIssues,
        closingIssues,
        verification: {
          baseBranch,
          requiredChecks,
          preflight: preflightConfig.commands,
          e2e: verificationConfig?.e2e ?? [],
          staging: verificationConfig?.staging ?? [],
          manualChecks,
        },
        batchId: batch.id,
        generatedAt: new Date().toISOString(),
      });

      const result = await ghWrite(repo)`gh pr create --repo ${repo} --base ${baseBranch} --head ${botBranch} --title "Rollup: ${today} batch (${prs.length} PRs)" --body ${body}`
        .cwd(repoPath)
        .quiet();

      const prUrl = result.stdout.toString().trim();
      console.log(`[ralph:rollup] Created rollup PR: ${prUrl}`);

      const prNumber = prUrl.match(/\/pull\/(\d+)(?:$|\?)/)?.[1];

      markRollupBatchRolledUp({
        batchId: batch.id,
        rollupPrUrl: prUrl,
        rollupPrNumber: prNumber ? Number(prNumber) : null,
      });

      const key = this.getRepoKeyForRepo(repo, botBranch);
      this.mergeCount.set(key, 0);
      this.mergedPRs.set(key, []);
      createNewRollupBatch({ repo, botBranch, batchSize: batch.batchSize });

      await notifyRollupReady(repo, prUrl, prs);

      return prUrl;
    } catch (e: any) {
      console.error(`[ralph:rollup] Failed to create rollup PR for ${repo} (${batch.id}):`, e);
      await notifyError(`Creating rollup PR for ${repo} (${batch.id})`, e.message, { repo });
      return null;
    }
    finally {
      // If we created a rollup PR, the lock can remain; it is batch-scoped.
      // If we failed, clear so a retry is possible without manual DB cleanup.
      if (leaseAcquired && !loadRollupBatchById(batch.id)?.rollupPrUrl) {
        deleteIdempotencyKey(lockKey);
      }
    }
  }

  private async findExistingRollupPR(
    repo: string,
    botBranch: string,
    baseBranch: string,
    repoPath: string,
    logPrefix: string
  ): Promise<RollupPullRequest | null> {
    try {
      const result = await ghRead(repo)`gh pr list --repo ${repo} --state open --base ${baseBranch} --head ${botBranch} --json url,body --limit 5`
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

  private async resolveRollupBaseBranch(repo: string, repoPath: string, logPrefix: string): Promise<string> {
    try {
      const result = await ghRead(repo)`gh api repos/${repo} --json default_branch`.cwd(repoPath).quiet();
      const output = result.stdout.toString().trim();
      if (!output) return "main";
      const parsed = JSON.parse(output);
      const branch = typeof parsed?.default_branch === "string" ? parsed.default_branch.trim() : "";
      return branch || "main";
    } catch (e: any) {
      console.warn(`${logPrefix} Failed to resolve default branch; falling back to main.`, e);
      return "main";
    }
  }

  private async fetchBranchProtection(
    repo: string,
    repoPath: string,
    branch: string,
    logPrefix: string
  ): Promise<BranchProtection | null> {
    try {
      const result = await ghRead(repo)`gh api repos/${repo}/branches/${encodeURIComponent(branch)}/protection`
        .cwd(repoPath)
        .quiet();
      const output = result.stdout.toString().trim();
      if (!output) return null;
      return JSON.parse(output) as BranchProtection;
    } catch (e: any) {
      const message = String(e?.message ?? "");
      if (message.includes("404") || message.toLowerCase().includes("not found")) {
        return null;
      }
      console.warn(`${logPrefix} Failed to read branch protection for ${branch}`, e);
      throw e;
    }
  }

  private async resolveRollupRequiredChecks(
    repo: string,
    repoPath: string,
    baseBranch: string,
    logPrefix: string
  ): Promise<ResolvedRequiredChecks> {
    return resolveRequiredChecks({
      override: getRepoRequiredChecksOverride(repo),
      primaryBranch: baseBranch,
      fetchBranchProtection: (branch) => this.fetchBranchProtection(repo, repoPath, branch, logPrefix),
      logger: {
        warn: (message) => console.warn(`${logPrefix} ${message}`),
        info: (message) => console.log(`${logPrefix} ${message}`),
      },
    });
  }

  private async collectRollupVerificationData(
    repo: string,
    batchId: string,
    entries: Array<{ prUrl: string; issueRefs: string[] }>,
    repoPath: string,
    logPrefix: string
  ): Promise<{ issueRefs: string[]; manualChecks: string[] }> {
    const refs = new Map<number, string>();
    const repoPrefix = `${repo}#`;
    const manualChecks: string[] = [];

    for (const entry of entries) {
      const data = await this.extractPrBodyData(repo, entry.prUrl, repoPath, logPrefix);

      if (data.issueRefs.length > 0) {
        try {
          updateRollupBatchEntryIssueRefs({ batchId, prUrl: entry.prUrl, issueRefs: data.issueRefs });
        } catch {
          // best-effort
        }
      }

      for (const ref of data.issueRefs) {
        if (!ref.startsWith(repoPrefix)) continue;
        const number = parseIssueNumberFromRef(ref);
        if (number !== null) refs.set(number, `${repo}#${number}`);
      }

      manualChecks.push(...data.manualChecks);
    }

    const issueRefs = [...refs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ref]) => ref);

    return {
      issueRefs,
      manualChecks: dedupePreserveOrder(manualChecks),
    };
  }

  private async extractPrBodyData(
    repo: string,
    pr: string,
    repoPath: string,
    logPrefix: string
  ): Promise<{ issueRefs: string[]; manualChecks: string[] }> {
    try {
      const result = await ghRead(repo)`gh pr view --repo ${repo} ${pr} --json body`.cwd(repoPath).quiet();
      const output = result.stdout.toString().trim();
      if (!output) {
        return { issueRefs: [], manualChecks: [] };
      }

      const parsed = JSON.parse(output);
      const body = typeof parsed?.body === "string" ? parsed.body : "";
      return {
        issueRefs: extractClosingIssuesFromBody(body, repo),
        manualChecks: extractManualChecksFromBody(body),
      };
    } catch (e: any) {
      console.warn(`${logPrefix} Failed to read PR body for rollup data (${pr})`, e);
      return { issueRefs: [], manualChecks: [] };
    }
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

  async checkIdleRollup(repo: string): Promise<string | null> {
    return this.createRollupPR(repo);
  }

  /**
   * Get current status
   */
  getStatus(): Map<string, { count: number; prs: string[] }> {
    const status = new Map<string, { count: number; prs: string[] }>();

    for (const [repo, key] of this.repoKeys.entries()) {
      status.set(repo, {
        count: this.mergeCount.get(key) ?? 0,
        prs: this.mergedPRs.get(key) || [],
      });
    }

    return status;
  }
}
