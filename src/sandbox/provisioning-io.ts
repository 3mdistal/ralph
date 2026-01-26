import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";

import { GitHubClient, splitRepoFullName } from "../github/client";
import { ensureRalphWorkflowLabelsOnce } from "../github/ensure-ralph-workflow-labels";
import { getRalphSandboxManifestPath } from "../paths";
import type { ManifestWarningDetail, SandboxManifest, SeededIssueRecord, SeededPullRequestRecord } from "./manifest";
import { readSandboxManifest, writeSandboxManifest } from "./manifest";
import type { NormalizedSeedSpec, NormalizedSeedIssue, NormalizedSeedPullRequest } from "./seed-spec";
import { getBaselineSeedSpec, loadSeedSpecFromFile } from "./seed-spec";
import type { ProvisionPlan } from "./provisioning-core";

type RepoInfo = {
  full_name: string;
  html_url: string;
  default_branch: string;
  visibility?: string;
  private?: boolean;
};

type GitRef = { object?: { sha?: string } };

type IssueResponse = { number: number; html_url: string };
type PullResponse = { number: number; html_url: string };

type Ports = {
  githubFactory: (repoContext: string) => GitHubClient;
  now: () => Date;
  log: (message: string) => void;
  warn: (message: string) => void;
  ensureLabels: (repoFullName: string, ports: Ports) => Promise<void>;
};

const defaultPorts: Ports = {
  githubFactory: (repoContext) => new GitHubClient(repoContext),
  now: () => new Date(),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  ensureLabels: async (repoFullName, ports) => {
    const github = ports.githubFactory(repoFullName);
    const outcome = await ensureRalphWorkflowLabelsOnce({ repo: repoFullName, github });
    if (!outcome.ok) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      ports.warn(`[ralph:sandbox] Failed to ensure ralph labels for ${repoFullName}: ${message}`);
    }
  },
};

function ensurePorts(ports?: Partial<Ports>): Ports {
  return { ...defaultPorts, ...(ports ?? {}) };
}

function toVisibility(repo: RepoInfo): string {
  if (repo.visibility) return repo.visibility;
  return repo.private ? "private" : "public";
}

function toIso(now: Date): string {
  return now.toISOString();
}

function normalizeBranchName(value: string): string {
  return value.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._/-]+/g, "-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, opts?: { attempts?: number; baseDelayMs?: number }): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 250;
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(baseDelayMs * Math.pow(2, i));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`[ralph:sandbox] ${label} failed`);
}

async function requestRepoInfo(client: GitHubClient, repoFullName: string): Promise<RepoInfo> {
  const { owner, name } = splitRepoFullName(repoFullName);
  const response = await client.request<RepoInfo>(`/repos/${owner}/${name}`);
  if (!response.data) {
    throw new Error(`[ralph:sandbox] Failed to fetch repo info for ${repoFullName}`);
  }
  return response.data;
}

async function createRepoFromTemplate(plan: ProvisionPlan, ports: Ports): Promise<RepoInfo> {
  const targetClient = ports.githubFactory(plan.repoFullName);
  const { owner: templateOwner, name: templateName } = splitRepoFullName(plan.templateRepo);

  const templateInfo = await targetClient.request<RepoInfo>(`/repos/${templateOwner}/${templateName}`);
  const templateDefaultBranch = templateInfo.data?.default_branch ?? "main";
  const includeAllBranches = plan.templateRef !== templateDefaultBranch;

  const response = await targetClient.request<RepoInfo>(`/repos/${templateOwner}/${templateName}/generate`, {
    method: "POST",
    body: {
      owner: plan.repoOwner,
      name: plan.repoName,
      private: true,
      include_all_branches: includeAllBranches,
    },
  });

  if (!response.data) {
    throw new Error(`[ralph:sandbox] Template generation failed for ${plan.templateRepo}`);
  }

  if (plan.templateRef && plan.templateRef !== response.data.default_branch) {
    try {
      await withRetry("set default branch", () =>
        targetClient.request(`/repos/${plan.repoOwner}/${plan.repoName}`, {
          method: "PATCH",
          body: { default_branch: plan.templateRef },
        })
      );
    } catch (error: any) {
      ports.warn(
        `[ralph:sandbox] Failed to set default branch to ${plan.templateRef} (repo ${plan.repoFullName}): ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  return await withRetry("fetch repo info", () => requestRepoInfo(targetClient, plan.repoFullName));
}

async function ensureBotBranch(params: {
  repoFullName: string;
  defaultBranch: string;
  botBranch: string;
  ports: Ports;
}): Promise<void> {
  const client = params.ports.githubFactory(params.repoFullName);
  if (params.botBranch === params.defaultBranch) return;
  const { owner, name } = splitRepoFullName(params.repoFullName);
  const encodedBot = encodeURIComponent(params.botBranch);

  const existing = await client.request<GitRef>(`/repos/${owner}/${name}/git/ref/heads/${encodedBot}`, {
    allowNotFound: true,
  });
  if (existing.status !== 404) return;

  const encodedDefault = encodeURIComponent(params.defaultBranch);
  const sha = await withRetry("fetch default branch sha", async () => {
    const defaultRef = await client.request<GitRef>(`/repos/${owner}/${name}/git/ref/heads/${encodedDefault}`);
    const value = defaultRef.data?.object?.sha;
    if (!value) {
      throw new Error(`[ralph:sandbox] Missing SHA for default branch ${params.defaultBranch}`);
    }
    return value;
  });

  await client.request(`/repos/${owner}/${name}/git/refs`, {
    method: "POST",
    body: {
      ref: `refs/heads/${params.botBranch}`,
      sha,
    },
  });
}

async function ensureRalphLabels(repoFullName: string, ports: Ports): Promise<void> {
  await ports.ensureLabels(repoFullName, ports);
}

function buildBranchProtectionPayload(source: any): any {
  if (!source || typeof source !== "object") return null;
  const requiredStatusChecks = source.required_status_checks
    ? {
        strict: Boolean(source.required_status_checks.strict),
        contexts: Array.isArray(source.required_status_checks.contexts)
          ? source.required_status_checks.contexts
          : Array.isArray(source.required_status_checks.checks)
            ? source.required_status_checks.checks
                .map((c: any) => c?.context)
                .filter(Boolean)
            : [],
      }
    : null;

  const normalizeRestriction = (list: any[], key: string) =>
    Array.isArray(list) ? list.map((item) => item?.[key] ?? item?.login ?? item?.slug ?? item?.name).filter(Boolean) : [];

  const requiredPullRequestReviews = source.required_pull_request_reviews
    ? {
        dismissal_restrictions: source.required_pull_request_reviews.dismissal_restrictions
          ? {
              users: normalizeRestriction(source.required_pull_request_reviews.dismissal_restrictions.users, "login"),
              teams: normalizeRestriction(source.required_pull_request_reviews.dismissal_restrictions.teams, "slug"),
              apps: normalizeRestriction(source.required_pull_request_reviews.dismissal_restrictions.apps, "slug"),
            }
          : undefined,
        dismiss_stale_reviews: Boolean(source.required_pull_request_reviews.dismiss_stale_reviews),
        require_code_owner_reviews: Boolean(source.required_pull_request_reviews.require_code_owner_reviews),
        required_approving_review_count: Number.isFinite(source.required_pull_request_reviews.required_approving_review_count)
          ? source.required_pull_request_reviews.required_approving_review_count
          : 0,
        require_last_push_approval: Boolean(source.required_pull_request_reviews.require_last_push_approval),
        required_review_thread_resolution: Boolean(source.required_pull_request_reviews.required_review_thread_resolution),
      }
    : null;

  const restrictions = source.restrictions
    ? {
        users: normalizeRestriction(source.restrictions.users, "login"),
        teams: normalizeRestriction(source.restrictions.teams, "slug"),
        apps: normalizeRestriction(source.restrictions.apps, "slug"),
      }
    : null;

  return {
    required_status_checks: requiredStatusChecks,
    enforce_admins: Boolean(source.enforce_admins?.enabled ?? source.enforce_admins),
    required_pull_request_reviews: requiredPullRequestReviews,
    restrictions,
    required_linear_history: Boolean(source.required_linear_history?.enabled ?? source.required_linear_history),
    allow_force_pushes: Boolean(source.allow_force_pushes?.enabled ?? source.allow_force_pushes),
    allow_deletions: Boolean(source.allow_deletions?.enabled ?? source.allow_deletions),
    block_creations: Boolean(source.block_creations?.enabled ?? source.block_creations),
    required_conversation_resolution: Boolean(
      source.required_conversation_resolution?.enabled ?? source.required_conversation_resolution
    ),
    lock_branch: Boolean(source.lock_branch?.enabled ?? source.lock_branch),
    allow_fork_syncing: Boolean(source.allow_fork_syncing?.enabled ?? source.allow_fork_syncing),
  };
}

async function copyBranchProtection(params: {
  templateRepo: string;
  targetRepo: string;
  branch: string;
  ports: Ports;
  warnings: string[];
  warningsDetailed?: ManifestWarningDetail[];
}): Promise<void> {
  const templateClient = params.ports.githubFactory(params.templateRepo);
  const targetClient = params.ports.githubFactory(params.targetRepo);
  const { owner: templateOwner, name: templateName } = splitRepoFullName(params.templateRepo);
  const { owner: targetOwner, name: targetName } = splitRepoFullName(params.targetRepo);
  const encodedBranch = encodeURIComponent(params.branch);

  let protection;
  try {
    protection = await templateClient.request(
      `/repos/${templateOwner}/${templateName}/branches/${encodedBranch}/protection`,
      { allowNotFound: true }
    );
  } catch (error: any) {
    recordWarning(
      params.warnings,
      params.warningsDetailed,
      "branch-protection",
      `branch protection fetch failed for ${params.branch}: ${error?.message ?? String(error)}`
    );
    return;
  }
  if (protection.status === 404) return;

  const payload = buildBranchProtectionPayload(protection.data);
  if (!payload) return;

  try {
    await targetClient.request(`/repos/${targetOwner}/${targetName}/branches/${encodedBranch}/protection`, {
      method: "PUT",
      body: payload,
    });
  } catch (error: any) {
    recordWarning(
      params.warnings,
      params.warningsDetailed,
      "branch-protection",
      `branch protection copy failed for ${params.branch}: ${error?.message ?? String(error)}`
    );
  }
}

async function copyRulesets(params: {
  templateRepo: string;
  targetRepo: string;
  ports: Ports;
  warnings: string[];
  warningsDetailed?: ManifestWarningDetail[];
}): Promise<void> {
  const templateClient = params.ports.githubFactory(params.templateRepo);
  const targetClient = params.ports.githubFactory(params.targetRepo);
  const { owner: templateOwner, name: templateName } = splitRepoFullName(params.templateRepo);
  const { owner: targetOwner, name: targetName } = splitRepoFullName(params.targetRepo);

  let rulesets: any[] = [];
  try {
    const response = await templateClient.request<any[]>(`/repos/${templateOwner}/${templateName}/rulesets?per_page=100`, {
      allowNotFound: true,
    });
    rulesets = response.data ?? [];
  } catch (error: any) {
    recordWarning(params.warnings, params.warningsDetailed, "rulesets", `ruleset list failed: ${error?.message ?? String(error)}`);
    return;
  }

  for (const ruleset of rulesets) {
    if (!ruleset?.id) continue;
    try {
      const detail = await templateClient.request<any>(
        `/repos/${templateOwner}/${templateName}/rulesets/${ruleset.id}`,
        { allowNotFound: true }
      );
      if (!detail.data) continue;

      const payload = {
        name: detail.data.name,
        target: detail.data.target,
        enforcement: detail.data.enforcement,
        conditions: detail.data.conditions,
        rules: detail.data.rules,
        bypass_actors: detail.data.bypass_actors,
      };

      await targetClient.request(`/repos/${targetOwner}/${targetName}/rulesets`, {
        method: "POST",
        body: payload,
      });
    } catch (error: any) {
      recordWarning(
        params.warnings,
        params.warningsDetailed,
        "rulesets",
        `ruleset copy failed (${ruleset?.name ?? ruleset?.id ?? "unknown"}): ${error?.message ?? String(error)}`
      );
    }
  }
}

function recordWarning(
  warnings: string[],
  warningsDetailed: ManifestWarningDetail[] | undefined,
  step: string,
  message: string,
  code?: string
): void {
  warnings.push(message);
  if (warningsDetailed) {
    warningsDetailed.push({ step, message, ...(code ? { code } : {}) });
  }
}

function initManifest(plan: ProvisionPlan, repo: RepoInfo, now: Date): SandboxManifest {
  return {
    schemaVersion: 1,
    runId: plan.runId,
    createdAt: toIso(now),
    templateRepo: plan.templateRepo,
    templateRef: plan.templateRef,
    repo: {
      fullName: repo.full_name,
      url: repo.html_url,
      visibility: toVisibility(repo),
    },
    settingsPreset: plan.settingsPreset,
    defaultBranch: repo.default_branch,
    botBranch: plan.botBranch,
    steps: {},
  };
}

export async function executeProvisionPlan(plan: ProvisionPlan, ports?: Partial<Ports>): Promise<SandboxManifest> {
  const io = ensurePorts(ports);
  const now = io.now();
  const manifestPath = getRalphSandboxManifestPath(plan.runId);

  const repo = await createRepoFromTemplate(plan, io);
  const manifest = initManifest(plan, repo, now);
  manifest.steps.provisionedAt = toIso(io.now());
  await writeSandboxManifest(manifestPath, manifest);

  await ensureRalphLabels(plan.repoFullName, io);
  await ensureBotBranch({
    repoFullName: plan.repoFullName,
    defaultBranch: repo.default_branch,
    botBranch: plan.botBranch,
    ports: io,
  });

  if (plan.settingsPreset === "parity") {
    const warnings: string[] = [];
    const warningsDetailed: ManifestWarningDetail[] = [];
    await copyBranchProtection({
      templateRepo: plan.templateRepo,
      targetRepo: plan.repoFullName,
      branch: repo.default_branch,
      ports: io,
      warnings,
      warningsDetailed,
    });
    if (plan.botBranch !== repo.default_branch) {
      await copyBranchProtection({
        templateRepo: plan.templateRepo,
        targetRepo: plan.repoFullName,
        branch: plan.botBranch,
        ports: io,
        warnings,
        warningsDetailed,
      });
    }
    await copyRulesets({
      templateRepo: plan.templateRepo,
      targetRepo: plan.repoFullName,
      ports: io,
      warnings,
      warningsDetailed,
    });
    if (warnings.length > 0) {
      manifest.warnings = [...(manifest.warnings ?? []), ...warnings];
      manifest.warningsDetailed = [...(manifest.warningsDetailed ?? []), ...warningsDetailed];
    }
  }

  manifest.steps.settingsAppliedAt = toIso(io.now());
  await writeSandboxManifest(manifestPath, manifest);
  return manifest;
}

function ensureSeedSection(manifest: SandboxManifest): Required<NonNullable<SandboxManifest["seed"]>> {
  if (!manifest.seed) {
    manifest.seed = { issues: [], pullRequests: [] };
  }
  if (!manifest.seed.issues) manifest.seed.issues = [];
  if (!manifest.seed.pullRequests) manifest.seed.pullRequests = [];
  return manifest.seed as Required<NonNullable<SandboxManifest["seed"]>>;
}

function recordIssue(seed: Required<NonNullable<SandboxManifest["seed"]>>, record: SeededIssueRecord): void {
  if (seed.issues.some((entry) => entry.key === record.key)) return;
  seed.issues.push(record);
}

function recordPullRequest(seed: Required<NonNullable<SandboxManifest["seed"]>>, record: SeededPullRequestRecord): void {
  if (seed.pullRequests.some((entry) => entry.key === record.key)) return;
  seed.pullRequests.push(record);
}

async function createIssue(params: {
  repoFullName: string;
  issue: NormalizedSeedIssue;
  ports: Ports;
}): Promise<SeededIssueRecord> {
  const client = params.ports.githubFactory(params.repoFullName);
  const { owner, name } = splitRepoFullName(params.repoFullName);
  const response = await client.request<IssueResponse>(`/repos/${owner}/${name}/issues`, {
    method: "POST",
    body: {
      title: params.issue.title,
      body: params.issue.body,
      labels: params.issue.labels,
    },
  });
  if (!response.data) throw new Error("[ralph:sandbox] Issue creation failed");
  const number = response.data.number;
  const url = response.data.html_url;

  for (const comment of params.issue.comments) {
    await client.request(`/repos/${owner}/${name}/issues/${number}/comments`, {
      method: "POST",
      body: { body: comment.body },
    });
  }

  return { key: params.issue.key, number, url };
}

async function createPullRequest(params: {
  repoFullName: string;
  pr: NormalizedSeedPullRequest;
  defaultBranch: string;
  ports: Ports;
}): Promise<SeededPullRequestRecord> {
  const client = params.ports.githubFactory(params.repoFullName);
  const { owner, name } = splitRepoFullName(params.repoFullName);
  const base = params.pr.base ?? params.defaultBranch;
  const headBranch = normalizeBranchName(params.pr.head ?? `seed/${params.pr.key}`);

  const encodedHead = encodeURIComponent(headBranch);
  const existing = await client.request<GitRef>(`/repos/${owner}/${name}/git/ref/heads/${encodedHead}`, {
    allowNotFound: true,
  });

  if (existing.status === 404) {
    const encodedBase = encodeURIComponent(base);
    const baseRef = await client.request<GitRef>(`/repos/${owner}/${name}/git/ref/heads/${encodedBase}`);
    const sha = baseRef.data?.object?.sha;
    if (!sha) throw new Error(`[ralph:sandbox] Missing SHA for base branch ${base}`);
    await client.request(`/repos/${owner}/${name}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${headBranch}`, sha },
    });
  }

  const file = params.pr.file ?? { path: `seed/${params.pr.key}.txt`, content: "seed" };
  const content = Buffer.from(file.content, "utf8").toString("base64");
  const encodedPath = file.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  await client.request(`/repos/${owner}/${name}/contents/${encodedPath}`, {
    method: "PUT",
    body: {
      message: `Seed ${params.pr.key}`,
      content,
      branch: headBranch,
    },
  });

  const response = await client.request<PullResponse>(`/repos/${owner}/${name}/pulls`, {
    method: "POST",
    body: {
      title: params.pr.title,
      body: params.pr.body,
      base,
      head: headBranch,
    },
  });
  if (!response.data) throw new Error("[ralph:sandbox] PR creation failed");
  const number = response.data.number;
  const url = response.data.html_url;

  for (const comment of params.pr.comments) {
    await client.request(`/repos/${owner}/${name}/issues/${number}/comments`, {
      method: "POST",
      body: { body: comment.body },
    });
  }

  return { key: params.pr.key, number, url };
}

export async function applySeedFromSpec(params: {
  repoFullName: string;
  manifest: SandboxManifest;
  seedSpec: NormalizedSeedSpec;
  seedConfig?: { preset?: "baseline"; file?: string };
  ports?: Partial<Ports>;
}): Promise<SandboxManifest> {
  const io = ensurePorts(params.ports);
  if (!params.manifest.steps) params.manifest.steps = {};
  const seed = ensureSeedSection(params.manifest);
  if (params.seedConfig?.preset) seed.preset = params.seedConfig.preset;
  if (params.seedConfig?.file) seed.file = params.seedConfig.file;

  await ensureRalphLabels(params.repoFullName, io);

  const issueMap = new Map(seed.issues.map((entry) => [entry.key, entry]));
  for (const issue of params.seedSpec.issues) {
    if (issueMap.has(issue.key)) continue;
    const record = await createIssue({ repoFullName: params.repoFullName, issue, ports: io });
    recordIssue(seed, record);
  }

  const prMap = new Map(seed.pullRequests.map((entry) => [entry.key, entry]));
  for (const pr of params.seedSpec.pullRequests) {
    if (prMap.has(pr.key)) continue;
    const record = await createPullRequest({
      repoFullName: params.repoFullName,
      pr,
      defaultBranch: params.manifest.defaultBranch,
      ports: io,
    });
    recordPullRequest(seed, record);
  }

  params.manifest.steps.seedAppliedAt = toIso(io.now());
  return params.manifest;
}

export async function resolveSeedSpecFromPlan(plan: ProvisionPlan): Promise<NormalizedSeedSpec | null> {
  if (!plan.seed) return null;
  if (plan.seed.spec) return plan.seed.spec;
  if (plan.seed.mode === "preset" && plan.seed.preset === "baseline") {
    return getBaselineSeedSpec();
  }
  if (plan.seed.mode === "file" && plan.seed.file) {
    return await loadSeedSpecFromFile(plan.seed.file);
  }
  return null;
}

export async function loadManifestByRunId(runId: string): Promise<SandboxManifest> {
  const path = getRalphSandboxManifestPath(runId);
  return await readSandboxManifest(path);
}

export async function findLatestManifestPath(manifestsDir: string): Promise<string | null> {
  try {
    const info = await stat(manifestsDir);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }

  const entries = await readdir(manifestsDir, { withFileTypes: true });
  let latestByCreatedAt: { path: string; ts: number } | null = null;
  let latestByMtime: { path: string; ts: number } | null = null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    const fullPath = join(manifestsDir, entry.name);
    try {
      const info = await stat(fullPath);
      const mtime = info.mtimeMs;
      if (!latestByMtime || mtime >= latestByMtime.ts) {
        latestByMtime = { path: fullPath, ts: mtime };
      }
      const createdAt = await readManifestCreatedAt(fullPath);
      if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
        if (!latestByCreatedAt || createdAt >= latestByCreatedAt.ts) {
          latestByCreatedAt = { path: fullPath, ts: createdAt };
        }
      }
    } catch {
      // ignore
    }
  }

  return latestByCreatedAt?.path ?? latestByMtime?.path ?? null;
}

async function readManifestCreatedAt(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as any;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schemaVersion !== 1) return null;
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt.trim() : "";
    if (!createdAt) return null;
    const ts = Date.parse(createdAt);
    if (!Number.isFinite(ts)) return null;
    return ts;
  } catch {
    return null;
  }
}

export async function readManifestOrNull(path: string): Promise<SandboxManifest | null> {
  try {
    return await readSandboxManifest(path);
  } catch {
    return null;
  }
}
