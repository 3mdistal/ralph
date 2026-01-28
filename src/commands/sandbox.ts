import { GitHubClient, splitRepoFullName } from "../github/client";
import {
  archiveRepo,
  deleteRepo,
  ensureRepoTopics,
  fetchRepoTopics,
  listOwnerRepos,
  type SandboxRepoRecord,
} from "../github/sandbox-repos";
import { getSandboxProfileConfig, getSandboxRetentionPolicy } from "../config";
import { executeSandboxActions } from "../sandbox/plan-executor";
import { buildSandboxRetentionPlan } from "../sandbox/retention";
import {
  SANDBOX_FAILED_TOPIC,
  SANDBOX_MARKER_TOPIC,
  hasSandboxMarker,
  isSandboxCandidate,
  type SandboxSelectorRules,
} from "../sandbox/selector";

type SandboxActionMode = "archive" | "delete";

type SandboxFlags = {
  dryRun: boolean;
  apply: boolean;
  delete: boolean;
  yes: boolean;
  max: number | null;
};

const DEFAULT_MAX_MUTATIONS = 20;

function formatSandboxUsage(): string {
  return [
    "Usage:",
    "  ralph sandbox <tag|teardown|prune> [options]",
    "",
    "Commands:",
    "  tag        Apply sandbox marker topics to candidate repos",
    "  teardown   Archive or delete a single sandbox repo",
    "  prune      Apply retention policy to sandbox repos",
  ].join("\n");
}

function formatSandboxTagUsage(): string {
  return [
    "Usage:",
    "  ralph sandbox tag [--failed] [--dry-run] [--apply] [--max <n>]",
    "",
    "Options:",
    "  --failed          Also add the run-failed topic",
    "  --dry-run         Report actions without making changes (default)",
    "  --apply           Apply changes",
    "  --max <n>         Cap total mutations (default: 20)",
  ].join("\n");
}

function formatSandboxTeardownUsage(): string {
  return [
    "Usage:",
    "  ralph sandbox teardown --repo <owner/repo> [--delete --yes] [--dry-run] [--apply]",
    "",
    "Options:",
    "  --repo <owner/repo>  Target repo",
    "  --delete             Delete instead of archive (requires --yes)",
    "  --yes                Acknowledge destructive delete",
    "  --dry-run             Report actions without making changes (default)",
    "  --apply               Apply changes",
  ].join("\n");
}

function formatSandboxPruneUsage(): string {
  return [
    "Usage:",
    "  ralph sandbox prune [--keep-last <n>] [--keep-failed-days <n>] [--delete --yes] [--max <n>] [--dry-run] [--apply]",
    "",
    "Options:",
    "  --keep-last <n>         Keep last N repos (default: from sandbox.retention or 10)",
    "  --keep-failed-days <n>  Keep failed repos for N days (default: from sandbox.retention or 14)",
    "  --delete                Delete instead of archive (requires --yes)",
    "  --yes                   Acknowledge destructive delete",
    "  --max <n>               Cap total mutations (default: 20)",
    "  --dry-run               Report actions without making changes (default)",
    "  --apply                 Apply changes",
  ].join("\n");
}

function parseNonNegativeInt(value: string): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < 0) return null;
  return floored;
}

function parseCommonFlags(args: string[]): SandboxFlags {
  let dryRun = true;
  let apply = false;
  let del = false;
  let yes = false;
  let max: number | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--apply") {
      apply = true;
      dryRun = false;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      apply = false;
      continue;
    }
    if (arg === "--delete") {
      del = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--max") {
      const value = args[i + 1] ?? "";
      const parsed = parseNonNegativeInt(value);
      if (parsed === null) {
        throw new Error(`Invalid --max value: ${value}`);
      }
      max = parsed;
      i += 1;
      continue;
    }
  }

  return { dryRun, apply, delete: del, yes, max };
}

function requireSandboxConfig(): { rules: SandboxSelectorRules; owners: string[] } {
  const sandbox = getSandboxProfileConfig();
  if (!sandbox) {
    console.error("Sandbox profile is required. Set profile=\"sandbox\" and configure the sandbox block.");
    process.exit(1);
  }
  return {
    owners: sandbox.allowedOwners,
    rules: {
      allowedOwners: sandbox.allowedOwners,
      repoNamePrefix: sandbox.repoNamePrefix,
    },
  };
}

async function listSandboxCandidates(rules: SandboxSelectorRules, owners: string[]): Promise<SandboxRepoRecord[]> {
  const repos: SandboxRepoRecord[] = [];
  for (const owner of owners) {
    const github = new GitHubClient(`${owner}/${rules.repoNamePrefix}probe`);
    const listed = await listOwnerRepos({ github, owner });
    for (const repo of listed) {
      if (isSandboxCandidate({ owner: repo.owner, name: repo.name, fullName: repo.fullName }, rules)) {
        repos.push(repo);
      }
    }
  }
  return repos;
}

async function hydrateTopics(repos: SandboxRepoRecord[]): Promise<SandboxRepoRecord[]> {
  return await Promise.all(
    repos.map(async (repo) => {
      const github = new GitHubClient(repo.fullName);
      const topics = await fetchRepoTopics({ github, repoFullName: repo.fullName });
      return { ...repo, topics };
    })
  );
}

function selectActionMode(flags: SandboxFlags): SandboxActionMode {
  if (!flags.delete) return "archive";
  if (!flags.yes) {
    throw new Error("Destructive deletes require --delete --yes.");
  }
  return "delete";
}

function clampActions<T>(items: T[], max: number | null): { selected: T[]; truncated: boolean } {
  const cap = max ?? DEFAULT_MAX_MUTATIONS;
  if (cap <= 0) return { selected: [], truncated: items.length > 0 };
  if (items.length <= cap) return { selected: items, truncated: false };
  return { selected: items.slice(0, cap), truncated: true };
}

async function runSandboxTag(args: string[]): Promise<void> {
  const { owners, rules } = requireSandboxConfig();
  const flags = parseCommonFlags(args);
  const failed = args.includes("--failed");
  const max = flags.max ?? DEFAULT_MAX_MUTATIONS;

  const candidates = await listSandboxCandidates(rules, owners);
  if (candidates.length === 0) {
    console.log("No sandbox candidate repos found.");
    process.exit(0);
  }

  const withTopics = await hydrateTopics(candidates);
  const pending = withTopics.filter((repo) => !hasSandboxMarker(repo));
  if (pending.length === 0) {
    console.log("All sandbox candidate repos already have the ralph-sandbox marker.");
    process.exit(0);
  }

  const { selected, truncated } = clampActions(pending, max);

  console.log(`Sandbox tag plan: ${selected.length} repo(s)${flags.dryRun ? " (dry-run)" : ""}`);
  for (const repo of selected) {
    const extras = failed ? ` +${SANDBOX_FAILED_TOPIC}` : "";
    console.log(`- ${repo.fullName} -> add ${SANDBOX_MARKER_TOPIC}${extras}`);
  }
  if (truncated) {
    console.warn(`Truncated to ${selected.length} repo(s) due to --max.`);
  }

  const actions = selected.map((repo) => ({ repoFullName: repo.fullName, action: "tag" as const }));
  const result = await executeSandboxActions({
    actions,
    apply: flags.apply,
    execute: async (action) => {
      const github = new GitHubClient(action.repoFullName);
      await ensureRepoTopics({
        github,
        repoFullName: action.repoFullName,
        topics: [SANDBOX_MARKER_TOPIC, ...(failed ? [SANDBOX_FAILED_TOPIC] : [])],
      });
    },
  });

  if (flags.apply && result.executed.length > 0) {
    console.log(`Tagged ${result.executed.length} repo(s).`);
  }

  process.exit(0);
}

async function runSandboxTeardown(args: string[]): Promise<void> {
  const { owners, rules } = requireSandboxConfig();
  const flags = parseCommonFlags(args);
  const repoFlag = args.findIndex((arg) => arg === "--repo");
  const repoFullName = repoFlag >= 0 ? (args[repoFlag + 1] ?? "") : "";

  if (!repoFullName || !repoFullName.includes("/")) {
    console.error("Missing required --repo <owner/repo>.");
    console.error(formatSandboxTeardownUsage());
    process.exit(1);
  }

  if (!owners.some((owner) => owner.toLowerCase() === repoFullName.split("/")[0]!.toLowerCase())) {
    console.error(`Repo owner is not in sandbox.allowedOwners: ${repoFullName}`);
    process.exit(1);
  }

  const { owner, name } = splitRepoFullName(repoFullName);
  if (!isSandboxCandidate({ owner, name, fullName: repoFullName }, rules)) {
    console.error(`Repo does not match sandbox prefix boundary: ${repoFullName}`);
    process.exit(1);
  }

  const github = new GitHubClient(repoFullName);
  const topics = await fetchRepoTopics({ github, repoFullName });
  if (!hasSandboxMarker({ owner, name, fullName: repoFullName, topics })) {
    console.error(`Refusing to mutate ${repoFullName} without ${SANDBOX_MARKER_TOPIC} marker.`);
    process.exit(1);
  }

  const mode = selectActionMode(flags);
  console.log(
    `Sandbox teardown plan: ${repoFullName} -> ${mode}${flags.dryRun ? " (dry-run)" : ""}`
  );

  const actions = [{ repoFullName, action: mode }];
  await executeSandboxActions({
    actions,
    apply: flags.apply,
    execute: async (action) => {
      const client = new GitHubClient(action.repoFullName);
      if (action.action === "delete") {
        await deleteRepo({ github: client, repoFullName: action.repoFullName });
      } else {
        await archiveRepo({ github: client, repoFullName: action.repoFullName });
      }
    },
  });

  process.exit(0);
}

async function runSandboxPrune(args: string[]): Promise<void> {
  const { owners, rules } = requireSandboxConfig();
  const flags = parseCommonFlags(args);
  const defaults = getSandboxRetentionPolicy();

  let keepLast = defaults.keepLast;
  let keepFailedDays = defaults.keepFailedDays;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--keep-last") {
      const value = args[i + 1] ?? "";
      const parsed = parseNonNegativeInt(value);
      if (parsed === null) {
        throw new Error(`Invalid --keep-last value: ${value}`);
      }
      keepLast = parsed;
      i += 1;
      continue;
    }
    if (arg === "--keep-failed-days") {
      const value = args[i + 1] ?? "";
      const parsed = parseNonNegativeInt(value);
      if (parsed === null) {
        throw new Error(`Invalid --keep-failed-days value: ${value}`);
      }
      keepFailedDays = parsed;
      i += 1;
      continue;
    }
  }

  const candidates = await listSandboxCandidates(rules, owners);
  if (candidates.length === 0) {
    console.log("No sandbox candidate repos found.");
    process.exit(0);
  }

  const withTopics = await hydrateTopics(candidates);
  const decisions = buildSandboxRetentionPlan({
    repos: withTopics.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.fullName,
      owner: repo.owner,
      createdAt: repo.createdAt,
      archived: repo.archived,
      topics: repo.topics,
    })),
    policy: { keepLast, keepFailedDays },
  });

  const mode = selectActionMode(flags);

  const eligible = decisions.filter((decision) => !decision.keep && hasSandboxMarker(decision.repo));
  const skippedMissingMarker = decisions.filter((decision) => !decision.keep && !hasSandboxMarker(decision.repo));

  const ordered = [...eligible].sort((a, b) => {
    const aMs = Date.parse(a.repo.createdAt);
    const bMs = Date.parse(b.repo.createdAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs;
    return a.repo.fullName.localeCompare(b.repo.fullName);
  });

  const { selected, truncated } = clampActions(ordered, flags.max ?? DEFAULT_MAX_MUTATIONS);

  console.log(
    `Sandbox prune plan: keepLast=${keepLast} keepFailedDays=${keepFailedDays} ` +
      `action=${mode}${flags.dryRun ? " (dry-run)" : ""}`
  );
  console.log(`- keep: ${decisions.filter((d) => d.keep).length}`);
  console.log(`- prune candidates: ${eligible.length}`);
  if (skippedMissingMarker.length > 0) {
    console.warn(`- skipped missing ${SANDBOX_MARKER_TOPIC}: ${skippedMissingMarker.length}`);
  }
  for (const decision of selected) {
    console.log(`- ${decision.repo.fullName} -> ${mode} (${decision.reason})`);
  }
  if (truncated) {
    console.warn(`Truncated to ${selected.length} repo(s) due to --max.`);
  }

  const actions = selected.map((decision) => ({
    repoFullName: decision.repo.fullName,
    action: mode,
    reason: decision.reason,
  }));

  await executeSandboxActions({
    actions,
    apply: flags.apply,
    execute: async (action) => {
      const client = new GitHubClient(action.repoFullName);
      if (action.action === "delete") {
        await deleteRepo({ github: client, repoFullName: action.repoFullName });
      } else {
        await archiveRepo({ github: client, repoFullName: action.repoFullName });
      }
    },
  });

  process.exit(0);
}

export async function runSandboxCommand(args: string[]): Promise<void> {
  const subcommand = args[1];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(formatSandboxUsage());
    process.exit(0);
  }

  try {
    if (subcommand === "tag") {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(formatSandboxTagUsage());
        process.exit(0);
      }
      await runSandboxTag(args.slice(2));
      return;
    }
    if (subcommand === "teardown") {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(formatSandboxTeardownUsage());
        process.exit(0);
      }
      await runSandboxTeardown(args.slice(2));
      return;
    }
    if (subcommand === "prune") {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(formatSandboxPruneUsage());
        process.exit(0);
      }
      await runSandboxPrune(args.slice(2));
      return;
    }

    console.error(`Unknown sandbox subcommand: ${subcommand}`);
    console.error(formatSandboxUsage());
    process.exit(1);
  } catch (err: any) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
