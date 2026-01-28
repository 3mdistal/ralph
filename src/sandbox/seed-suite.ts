import { readFile, writeFile, access } from "fs/promises";
import { constants as fsConstants } from "fs";
import { dirname } from "path";

import { getProfile, getSandboxProfileConfig } from "../config";
import { GitHubApiError, GitHubClient, splitRepoFullName } from "../github/client";
import { ensureRalphWorkflowLabelsOnce } from "../github/ensure-ralph-workflow-labels";
import { executeIssueLabelOps, planIssueLabelOps } from "../github/issue-label-io";
import { evaluateSandboxTripwire } from "../github/sandbox-tripwire";
import { GitHubRelationshipProvider } from "../github/issue-relationships";
import { formatIssueRef, type IssueRef } from "../github/issue-ref";
import {
  buildManagedBodyLines,
  buildManagedRegion,
  formatSeedMarker,
  parseSeedMarker,
  replaceManagedRegion,
} from "./seed-body";
import {
  parseSeedManifest,
  listManifestSlugs,
  type SeedManifest,
  type SeedScenario,
  type SeedLabelSpec,
  type SeedLabelRename,
} from "./seed-manifest";

type SeedSuiteOptions = {
  repo: string;
  manifestPath: string;
  outputPath: string;
  dryRun: boolean;
  json: boolean;
  verify: boolean;
  force: boolean;
  maxScanPages: number;
};

type SeedIssue = {
  number: number;
  url: string | null;
  nodeId: string | null;
  title: string;
  body: string;
  state: "open" | "closed" | "unknown";
  labels: string[];
};

type SeedIdsFile = {
  version: "v1";
  repo: string;
  manifestVersion: string;
  generatedAt: string;
  seedLabel: string;
  scenarios: Record<string, { issue: { number: number; url: string | null; nodeId: string | null } }>;
};

type SeedPlanOp = {
  action: string;
  slug?: string;
  issueNumber?: number;
  detail?: string;
};

type RelationshipCapability = {
  blockedByApi: boolean | null;
  subIssuesApi: boolean | null;
};

const RUN_LOCK_LABEL = "ralph:seed-suite:run";
const RUN_LOCK_TTL_MS = 10 * 60_000;

const GRAPH_ISSUE_ID_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) { id }
    }
  }
`;

const GRAPH_ADD_BLOCKED_BY = `
  mutation($issueId: ID!, $blockedById: ID!) {
    addBlockedBy(input: { issueId: $issueId, blockedById: $blockedById }) {
      issue { id }
    }
  }
`;

const GRAPH_ADD_SUB_ISSUE = `
  mutation($issueId: ID!, $subIssueId: ID!) {
    addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
      issue { id }
    }
  }
`;

function normalizeIssueState(state?: string | null): "open" | "closed" | "unknown" {
  const normalized = (state ?? "").toUpperCase();
  if (normalized === "OPEN") return "open";
  if (normalized === "CLOSED") return "closed";
  return "unknown";
}

function extractLabelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const names = labels
    .map((label) => {
      if (typeof label === "string") return label;
      if (label && typeof label === "object" && "name" in label) {
        const name = (label as { name?: string | null }).name;
        return name ?? "";
      }
      return "";
    })
    .map((label) => label.trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

function mapScenarioLabels(manifest: SeedManifest, scenario: SeedScenario): string[] {
  const labels = new Set<string>();
  labels.add(manifest.seedLabel);
  (scenario.labels ?? []).forEach((label) => labels.add(label));
  return Array.from(labels);
}

function buildSeedBody(params: {
  manifest: SeedManifest;
  scenario: SeedScenario;
  slugToRef: Map<string, IssueRef>;
}): string {
  const markerLine = formatSeedMarker(params.manifest.marker, params.scenario.slug);
  const managedLines = buildManagedBodyLines({ body: params.scenario.body, slugToRef: params.slugToRef });
  const region = buildManagedRegion(managedLines);
  return [markerLine, region].join("\n");
}

function applyManagedSeedBody(params: {
  manifest: SeedManifest;
  scenario: SeedScenario;
  slugToRef: Map<string, IssueRef>;
  existingBody: string;
}): string {
  const markerLine = formatSeedMarker(params.manifest.marker, params.scenario.slug);
  const managedLines = buildManagedBodyLines({ body: params.scenario.body, slugToRef: params.slugToRef });
  const region = buildManagedRegion(managedLines);
  return replaceManagedRegion({ body: params.existingBody, markerLine, region });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSeedIds(path: string): Promise<SeedIdsFile | null> {
  if (!(await fileExists(path))) return null;
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw) as SeedIdsFile;
  } catch {
    return null;
  }
}

async function writeSeedIds(path: string, payload: SeedIdsFile): Promise<void> {
  await writeFile(path, JSON.stringify(payload, null, 2));
}

async function ensureDir(path: string): Promise<void> {
  await import("fs/promises").then((fs) => fs.mkdir(path, { recursive: true }));
}

async function listIssues(params: {
  github: GitHubClient;
  repo: string;
  query: string;
  maxPages: number;
}): Promise<SeedIssue[]> {
  const { owner, name } = splitRepoFullName(params.repo);
  const results: SeedIssue[] = [];
  for (let page = 1; page <= params.maxPages; page += 1) {
    const response = await params.github.request<any[]>(
      `/repos/${owner}/${name}/issues?${params.query}&per_page=100&page=${page}`
    );
    const items = response.data ?? [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const number = typeof item.number === "number" ? item.number : NaN;
      if (!Number.isFinite(number)) continue;
      results.push({
        number,
        url: typeof item.html_url === "string" ? item.html_url : null,
        nodeId: typeof item.node_id === "string" ? item.node_id : null,
        title: typeof item.title === "string" ? item.title : "",
        body: typeof item.body === "string" ? item.body : "",
        state: normalizeIssueState(item.state),
        labels: extractLabelNames(item.labels),
      });
    }
    if (items.length < 100) break;
  }
  return results;
}

async function fetchIssue(params: {
  github: GitHubClient;
  repo: string;
  number: number;
}): Promise<SeedIssue | null> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<any>(
    `/repos/${owner}/${name}/issues/${params.number}`,
    { allowNotFound: true }
  );
  if (!response.data) return null;
  const item = response.data;
  return {
    number: typeof item.number === "number" ? item.number : params.number,
    url: typeof item.html_url === "string" ? item.html_url : null,
    nodeId: typeof item.node_id === "string" ? item.node_id : null,
    title: typeof item.title === "string" ? item.title : "",
    body: typeof item.body === "string" ? item.body : "",
    state: normalizeIssueState(item.state),
    labels: extractLabelNames(item.labels),
  };
}

async function createIssue(params: {
  github: GitHubClient;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<SeedIssue> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<any>(`/repos/${owner}/${name}/issues`, {
    method: "POST",
    body: {
      title: params.title,
      body: params.body,
      labels: params.labels,
    },
  });
  const item = response.data ?? {};
  return {
    number: typeof item.number === "number" ? item.number : -1,
    url: typeof item.html_url === "string" ? item.html_url : null,
    nodeId: typeof item.node_id === "string" ? item.node_id : null,
    title: typeof item.title === "string" ? item.title : params.title,
    body: typeof item.body === "string" ? item.body : params.body,
    state: normalizeIssueState(item.state),
    labels: extractLabelNames(item.labels),
  };
}

async function updateIssue(params: {
  github: GitHubClient;
  repo: string;
  number: number;
  patch: { title?: string; body?: string; state?: "open" | "closed" };
}): Promise<void> {
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.number}`, {
    method: "PATCH",
    body: params.patch,
  });
}

async function ensureLabelSpecs(params: {
  github: GitHubClient;
  repo: string;
  labels: SeedLabelSpec[];
  plan: SeedPlanOp[];
  dryRun: boolean;
}): Promise<void> {
  if (params.labels.length === 0) return;
  const existing = await params.github.listLabelSpecs();
  const existingByName = new Map(existing.map((label) => [label.name, label]));
  for (const label of params.labels) {
    const current = existingByName.get(label.name);
    if (!current) {
      params.plan.push({ action: "create-label", detail: label.name });
      if (!params.dryRun) {
        await params.github.createLabel({
          name: label.name,
          color: label.color,
          description: label.description ?? "",
        });
      }
      continue;
    }
    const needsUpdate =
      (label.color && current.color !== label.color) ||
      ((label.description ?? null) !== (current.description ?? null));
    if (needsUpdate) {
      params.plan.push({ action: "update-label", detail: label.name });
      if (!params.dryRun) {
        await params.github.updateLabel(label.name, {
          color: label.color,
          description: label.description ?? undefined,
        });
      }
    }
  }
}

async function applyLabelRenames(params: {
  github: GitHubClient;
  repo: string;
  renames: SeedLabelRename[];
  plan: SeedPlanOp[];
  dryRun: boolean;
}): Promise<void> {
  if (params.renames.length === 0) return;
  const existing = await params.github.listLabelSpecs();
  const existingNames = new Set(existing.map((label) => label.name));
  const { owner, name } = splitRepoFullName(params.repo);
  for (const rename of params.renames) {
    if (existingNames.has(rename.to)) continue;
    if (!existingNames.has(rename.from)) continue;
    params.plan.push({ action: "rename-label", detail: `${rename.from} -> ${rename.to}` });
    if (!params.dryRun) {
      await params.github.request(`/repos/${owner}/${name}/labels/${encodeURIComponent(rename.from)}`, {
        method: "PATCH",
        body: { new_name: rename.to, description: rename.description ?? undefined },
      });
    }
  }
}

async function ensureRunLock(params: {
  github: GitHubClient;
  repo: string;
  dryRun: boolean;
  force: boolean;
  plan: SeedPlanOp[];
}): Promise<void> {
  const now = Date.now();
  const { owner, name } = splitRepoFullName(params.repo);
  const lockTitle = "Ralph Seed Suite Run Lock";
  const lockBody = `<!-- ralph-seed-suite:run-lock -->\nLast run: ${new Date(now).toISOString()}`;
  const issues = await listIssues({
    github: params.github,
    repo: params.repo,
    query: `state=open&labels=${encodeURIComponent(RUN_LOCK_LABEL)}&sort=created&direction=desc`,
    maxPages: 1,
  });
  const existing = issues[0];
  if (existing && !params.force) {
    const lastRunMatch = existing.body.match(/Last run:\s*(?<iso>[^\n]+)/);
    const lastRun = lastRunMatch?.groups?.iso ? Date.parse(lastRunMatch.groups.iso) : NaN;
    if (Number.isFinite(lastRun)) {
      if (now - lastRun < RUN_LOCK_TTL_MS) {
        throw new Error(
          `Seeder run lock is active (last run ${new Date(lastRun).toISOString()}). Use --force to bypass.`
        );
      }
    }
  }

  if (!existing) {
    params.plan.push({ action: "create-run-lock", detail: lockTitle });
    if (!params.dryRun) {
      await params.github.request(`/repos/${owner}/${name}/issues`, {
        method: "POST",
        body: { title: lockTitle, body: lockBody, labels: [RUN_LOCK_LABEL] },
      });
    }
    return;
  }

  params.plan.push({ action: "update-run-lock", issueNumber: existing.number });
  if (!params.dryRun) {
    await params.github.request(`/repos/${owner}/${name}/issues/${existing.number}`, {
      method: "PATCH",
      body: { body: lockBody },
    });
  }
}

function buildPlaceholderBody(manifest: SeedManifest, slug: string): string {
  const markerLine = formatSeedMarker(manifest.marker, slug);
  const region = buildManagedRegion(["Seed content pending; will reconcile after creation."]);
  return [markerLine, region].join("\n");
}

function buildDesiredIssue(params: {
  manifest: SeedManifest;
  scenario: SeedScenario;
  slugToRef: Map<string, IssueRef>;
  existingBody?: string;
}): { title: string; body: string; state: "open" | "closed"; labels: string[] } {
  const title = params.scenario.title;
  const state = params.scenario.state ?? "open";
  const labels = mapScenarioLabels(params.manifest, params.scenario);
  const body = params.existingBody
    ? applyManagedSeedBody({
        manifest: params.manifest,
        scenario: params.scenario,
        slugToRef: params.slugToRef,
        existingBody: params.existingBody,
      })
    : buildSeedBody({ manifest: params.manifest, scenario: params.scenario, slugToRef: params.slugToRef });
  return { title, body, state, labels };
}

function compareLabelSets(current: string[], desired: string[]): { add: string[]; remove: string[] } {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  const add: string[] = [];
  const remove: string[] = [];
  for (const label of desiredSet) if (!currentSet.has(label)) add.push(label);
  for (const label of currentSet) if (!desiredSet.has(label)) remove.push(label);
  return { add, remove };
}

function parseTaskListRefs(body: string, baseRepo: string): IssueRef[] {
  const refs: IssueRef[] = [];
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const match = raw.trim().match(/^(?:[-*]\s+)?\[[ xX]\]\s+(?<rest>.+)$/);
    if (!match?.groups?.rest) continue;
    const rest = match.groups.rest.trim();
    const refMatch = rest.match(/^(?<ref>(?:[\w.-]+\/[\w.-]+)?#\d+)/);
    if (!refMatch?.groups?.ref) continue;
    const parsed = refMatch.groups.ref.match(/^(?:(?<repo>[\w.-]+\/[\w.-]+))?#(?<num>\d+)$/);
    if (!parsed?.groups?.num) continue;
    const repo = parsed.groups.repo ?? baseRepo;
    const number = Number.parseInt(parsed.groups.num, 10);
    if (!Number.isFinite(number)) continue;
    refs.push({ repo, number });
  }
  return refs;
}

async function resolveIssueNodeId(params: {
  github: GitHubClient;
  repo: string;
  number: number;
}): Promise<string | null> {
  const { owner, name } = splitRepoFullName(params.repo);
  try {
    const response = await params.github.request<any>("/graphql", {
      method: "POST",
      body: { query: GRAPH_ISSUE_ID_QUERY, variables: { owner, name, number: params.number } },
    });
    const issue = response.data?.data?.repository?.issue;
    return issue?.id ?? null;
  } catch (error) {
    if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status)) return null;
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) return false;
  if (error.status !== 422) return false;
  return /already exists/i.test(error.responseText);
}

async function tryRestAddBlockedBy(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  blockedByNumber: number;
}): Promise<boolean> {
  const { owner, name } = splitRepoFullName(params.repo);
  try {
    await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/dependencies`, {
      method: "POST",
      body: { dependencies: [params.blockedByNumber] },
    });
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) return true;
    if (error instanceof GitHubApiError && [404, 405, 415, 422].includes(error.status)) {
      return false;
    }
    throw error;
  }
}

async function tryRestAddSubIssue(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  subIssueNumber: number;
}): Promise<boolean> {
  const { owner, name } = splitRepoFullName(params.repo);
  try {
    await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/sub_issues`, {
      method: "POST",
      body: { sub_issues: [params.subIssueNumber] },
    });
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) return true;
    if (error instanceof GitHubApiError && [404, 405, 415, 422].includes(error.status)) {
      return false;
    }
    throw error;
  }
}

async function tryGraphAddBlockedBy(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  blockedByNumber: number;
}): Promise<boolean> {
  const issueId = await resolveIssueNodeId({ github: params.github, repo: params.repo, number: params.issueNumber });
  const blockedById = await resolveIssueNodeId({
    github: params.github,
    repo: params.repo,
    number: params.blockedByNumber,
  });
  if (!issueId || !blockedById) return false;
  try {
    const response = await params.github.request<any>("/graphql", {
      method: "POST",
      body: { query: GRAPH_ADD_BLOCKED_BY, variables: { issueId, blockedById } },
    });
    const errors = response.data?.errors;
    if (Array.isArray(errors) && errors.some((err) => /already exists/i.test(String(err?.message ?? "")))) {
      return true;
    }
    if (response.data?.errors?.length) return false;
    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status)) return false;
    throw error;
  }
}

async function tryGraphAddSubIssue(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  subIssueNumber: number;
}): Promise<boolean> {
  const issueId = await resolveIssueNodeId({ github: params.github, repo: params.repo, number: params.issueNumber });
  const subIssueId = await resolveIssueNodeId({ github: params.github, repo: params.repo, number: params.subIssueNumber });
  if (!issueId || !subIssueId) return false;
  try {
    const response = await params.github.request<any>("/graphql", {
      method: "POST",
      body: { query: GRAPH_ADD_SUB_ISSUE, variables: { issueId, subIssueId } },
    });
    const errors = response.data?.errors;
    if (Array.isArray(errors) && errors.some((err) => /already exists/i.test(String(err?.message ?? "")))) {
      return true;
    }
    if (response.data?.errors?.length) return false;
    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status)) return false;
    throw error;
  }
}

async function ensureApiRelationship(params: {
  github: GitHubClient;
  repo: string;
  source: "blockedBy" | "subIssue";
  issueNumber: number;
  targetNumber: number;
  capability: RelationshipCapability;
}): Promise<void> {
  if (params.source === "blockedBy") {
    if (params.capability.blockedByApi === false) return;
    const restOk = await tryRestAddBlockedBy({
      github: params.github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      blockedByNumber: params.targetNumber,
    });
    if (restOk) {
      params.capability.blockedByApi = true;
      return;
    }
    const graphOk = await tryGraphAddBlockedBy({
      github: params.github,
      repo: params.repo,
      issueNumber: params.issueNumber,
      blockedByNumber: params.targetNumber,
    });
    params.capability.blockedByApi = graphOk ? true : false;
    return;
  }

  if (params.capability.subIssuesApi === false) return;
  const restOk = await tryRestAddSubIssue({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    subIssueNumber: params.targetNumber,
  });
  if (restOk) {
    params.capability.subIssuesApi = true;
    return;
  }
  const graphOk = await tryGraphAddSubIssue({
    github: params.github,
    repo: params.repo,
    issueNumber: params.issueNumber,
    subIssueNumber: params.targetNumber,
  });
  params.capability.subIssuesApi = graphOk ? true : false;
}

function buildVerificationErrors(params: {
  manifest: SeedManifest;
  scenario: SeedScenario;
  issue: SeedIssue;
  slugToRef: Map<string, IssueRef>;
  baseRepo: string;
  relationshipSnapshot: Awaited<ReturnType<GitHubRelationshipProvider["getSnapshot"]>>;
}): string[] {
  const errors: string[] = [];
  const desired = buildDesiredIssue({
    manifest: params.manifest,
    scenario: params.scenario,
    slugToRef: params.slugToRef,
    existingBody: params.issue.body,
  });
  if (params.issue.title !== desired.title) {
    errors.push(`title mismatch (expected "${desired.title}")`);
  }
  if (normalizeIssueState(params.issue.state) !== desired.state) {
    errors.push(`state mismatch (expected ${desired.state})`);
  }
  const { add, remove } = compareLabelSets(params.issue.labels, desired.labels);
  if (add.length > 0 || remove.length > 0) {
    errors.push(`labels mismatch (missing: ${add.join(", ") || "none"}; extra: ${remove.join(", ") || "none"})`);
  }
  const marker = parseSeedMarker(params.issue.body);
  if (!marker || marker.marker !== params.manifest.marker || marker.slug !== params.scenario.slug) {
    errors.push("seed marker missing or mismatched");
  }

  if (params.issue.body !== desired.body) {
    errors.push("managed body content mismatch");
  }

  if (params.scenario.body?.implicitBlockedBy) {
    if (!params.issue.body.includes(params.scenario.body.implicitBlockedBy.trim())) {
      errors.push("implicit blocked-by sentence missing");
    }
  }

  const signals = params.relationshipSnapshot.signals;
  const bySource = (source: "github" | "body", kind: "blocked_by" | "sub_issue", ref: IssueRef) =>
    signals.some(
      (signal) =>
        signal.source === source &&
        signal.kind === kind &&
        signal.ref?.repo === ref.repo &&
        signal.ref?.number === ref.number
    );

  const blockedBy = params.scenario.relationships?.blockedBy ?? [];
  for (const rel of blockedBy) {
    const ref = params.slugToRef.get(rel.slug);
    if (!ref) continue;
    if (rel.source === "body") {
      if (!bySource("body", "blocked_by", ref)) {
        errors.push(`missing body blocked-by ${formatIssueRef(ref)}`);
      }
    } else if (!bySource("github", "blocked_by", ref)) {
      errors.push(`missing API blocked-by ${formatIssueRef(ref)}`);
    }
  }

  const subIssues = params.scenario.relationships?.subIssues ?? [];
  for (const rel of subIssues) {
    const ref = params.slugToRef.get(rel.slug);
    if (!ref) continue;
    if (rel.source === "api") {
      if (!bySource("github", "sub_issue", ref)) {
        errors.push(`missing API sub-issue ${formatIssueRef(ref)}`);
      }
    } else {
      const taskRefs = parseTaskListRefs(params.issue.body, params.baseRepo);
      const hasRef = taskRefs.some((taskRef) => taskRef.repo === ref.repo && taskRef.number === ref.number);
      if (!hasRef) {
        errors.push(`missing body task list ref ${formatIssueRef(ref)}`);
      }
    }
  }

  return errors;
}

export async function runSeedSuite(opts: SeedSuiteOptions): Promise<void> {
  if (getProfile() !== "sandbox") {
    throw new Error("Sandbox seed suite requires profile=sandbox.");
  }

  const sandbox = getSandboxProfileConfig();
  if (!sandbox) {
    throw new Error("Sandbox profile requires sandbox config.");
  }

  const tripwire = evaluateSandboxTripwire({
    profile: "sandbox",
    repo: opts.repo,
    allowedOwners: sandbox.allowedOwners,
    repoNamePrefix: sandbox.repoNamePrefix,
  });
  if (!tripwire.allowed) {
    throw new Error(`Sandbox tripwire denied seed suite: ${tripwire.reason}`);
  }

  const raw = await readFile(opts.manifestPath, "utf8");
  const manifest = parseSeedManifest(raw);
  const github = new GitHubClient(opts.repo);
  const plan: SeedPlanOp[] = [];

  await ensureRunLock({ github, repo: opts.repo, dryRun: opts.dryRun, force: opts.force, plan });

  const labelSpecs: SeedLabelSpec[] = manifest.labels ?? [];
  if (!labelSpecs.find((label) => label.name === manifest.seedLabel)) {
    labelSpecs.push({ name: manifest.seedLabel, color: "1D76DB", description: "Seed suite artifacts" });
  }
  if (!labelSpecs.find((label) => label.name === RUN_LOCK_LABEL)) {
    labelSpecs.push({ name: RUN_LOCK_LABEL, color: "B60205", description: "Seed suite run lock" });
  }

  const ensureOutcome = await ensureRalphWorkflowLabelsOnce({ repo: opts.repo, github });
  if (!ensureOutcome.ok && !opts.dryRun) {
    throw new Error("Failed to ensure Ralph workflow labels; check GitHub permissions.");
  }
  await ensureLabelSpecs({ github, repo: opts.repo, labels: labelSpecs, plan, dryRun: opts.dryRun });
  await applyLabelRenames({
    github,
    repo: opts.repo,
    renames: manifest.labelRenames ?? [],
    plan,
    dryRun: opts.dryRun,
  });

  const seedIds = await readSeedIds(opts.outputPath);
  const slugToIssue = new Map<string, SeedIssue>();
  const slugToRef = new Map<string, IssueRef>();
  const manifestSlugs = listManifestSlugs(manifest);

  if (seedIds && seedIds.repo === opts.repo && seedIds.manifestVersion === manifest.version) {
    for (const [slug, entry] of Object.entries(seedIds.scenarios)) {
      if (!manifestSlugs.includes(slug)) continue;
      const issue = await fetchIssue({ github, repo: opts.repo, number: entry.issue.number });
      if (!issue) continue;
      const marker = parseSeedMarker(issue.body);
      if (marker?.marker === manifest.marker && marker.slug === slug) {
        slugToIssue.set(slug, issue);
      }
    }
  }

  if (slugToIssue.size === 0) {
    const labeled = await listIssues({
      github,
      repo: opts.repo,
      query: `state=all&labels=${encodeURIComponent(manifest.seedLabel)}&sort=created&direction=desc`,
      maxPages: opts.maxScanPages,
    });
    for (const issue of labeled) {
      const marker = parseSeedMarker(issue.body);
      if (marker?.marker === manifest.marker && marker.slug) {
        slugToIssue.set(marker.slug, issue);
      }
    }
  }

  if (slugToIssue.size === 0) {
    const recent = await listIssues({
      github,
      repo: opts.repo,
      query: "state=all&sort=created&direction=desc",
      maxPages: opts.maxScanPages,
    });
    for (const issue of recent) {
      const marker = parseSeedMarker(issue.body);
      if (marker?.marker === manifest.marker && marker.slug) {
        slugToIssue.set(marker.slug, issue);
      }
    }
  }

  for (const scenario of manifest.scenarios) {
    const existing = slugToIssue.get(scenario.slug);
    if (existing) continue;
    plan.push({ action: "create-issue", slug: scenario.slug });
    if (opts.dryRun) continue;
    const issue = await createIssue({
      github,
      repo: opts.repo,
      title: scenario.title,
      body: buildPlaceholderBody(manifest, scenario.slug),
      labels: mapScenarioLabels(manifest, scenario),
    });
    slugToIssue.set(scenario.slug, issue);
  }

  for (const [slug, issue] of slugToIssue.entries()) {
    slugToRef.set(slug, { repo: opts.repo, number: issue.number });
  }

  for (const scenario of manifest.scenarios) {
    const issue = slugToIssue.get(scenario.slug);
    if (!issue) continue;
    const desired = buildDesiredIssue({
      manifest,
      scenario,
      slugToRef,
      existingBody: issue.body,
    });
    const patch: { title?: string; body?: string; state?: "open" | "closed" } = {};
    if (issue.title !== desired.title) patch.title = desired.title;
    if (issue.body !== desired.body) patch.body = desired.body;
    if (issue.state !== desired.state) patch.state = desired.state;
    if (Object.keys(patch).length > 0) {
      plan.push({ action: "update-issue", slug: scenario.slug, issueNumber: issue.number });
      if (!opts.dryRun) {
        await updateIssue({ github, repo: opts.repo, number: issue.number, patch });
        const refreshed = await fetchIssue({ github, repo: opts.repo, number: issue.number });
        if (refreshed) slugToIssue.set(scenario.slug, refreshed);
      }
    }

    const labels = mapScenarioLabels(manifest, scenario);
    const labelDelta = compareLabelSets(issue.labels, labels);
    if (labelDelta.add.length > 0 || labelDelta.remove.length > 0) {
      plan.push({ action: "update-labels", slug: scenario.slug, issueNumber: issue.number });
      if (!opts.dryRun) {
        const ops = planIssueLabelOps({ add: labelDelta.add, remove: labelDelta.remove });
        await executeIssueLabelOps({
          github,
          repo: opts.repo,
          issueNumber: issue.number,
          ops,
          allowNonRalph: false,
        });
      }
    }
  }

  const orphans: SeedIssue[] = [];
  for (const [slug, issue] of slugToIssue.entries()) {
    if (!manifestSlugs.includes(slug)) {
      orphans.push(issue);
    }
  }
  for (const orphan of orphans) {
    plan.push({ action: "close-orphan", issueNumber: orphan.number });
    if (!opts.dryRun) {
      await updateIssue({ github, repo: opts.repo, number: orphan.number, patch: { state: "closed" } });
      const ops = planIssueLabelOps({ add: ["ralph:seed:orphaned"], remove: [] });
      await executeIssueLabelOps({
        github,
        repo: opts.repo,
        issueNumber: orphan.number,
        ops,
        allowNonRalph: false,
      });
    }
  }

  const capability: RelationshipCapability = { blockedByApi: null, subIssuesApi: null };
  for (const scenario of manifest.scenarios) {
    const issue = slugToIssue.get(scenario.slug);
    if (!issue) continue;
    const relationships = scenario.relationships;
    const blockedBy = relationships?.blockedBy?.filter((rel) => rel.source === "api") ?? [];
    for (const rel of blockedBy) {
      const target = slugToIssue.get(rel.slug);
      if (!target) continue;
      plan.push({ action: "ensure-blocked-by", slug: scenario.slug, issueNumber: issue.number });
      if (!opts.dryRun) {
        await ensureApiRelationship({
          github,
          repo: opts.repo,
          source: "blockedBy",
          issueNumber: issue.number,
          targetNumber: target.number,
          capability,
        });
      }
    }

    const subIssues = relationships?.subIssues?.filter((rel) => rel.source === "api") ?? [];
    for (const rel of subIssues) {
      const target = slugToIssue.get(rel.slug);
      if (!target) continue;
      plan.push({ action: "ensure-sub-issue", slug: scenario.slug, issueNumber: issue.number });
      if (!opts.dryRun) {
        await ensureApiRelationship({
          github,
          repo: opts.repo,
          source: "subIssue",
          issueNumber: issue.number,
          targetNumber: target.number,
          capability,
        });
      }
    }
  }

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ plan }, null, 2));
    } else {
      console.log("Seed suite plan:");
      for (const step of plan) {
        const detail = step.detail ? ` ${step.detail}` : "";
        const issueLabel = step.issueNumber ? ` #${step.issueNumber}` : "";
        const slug = step.slug ? ` (${step.slug})` : "";
        console.log(`- ${step.action}${issueLabel}${slug}${detail}`);
      }
    }
    return;
  }

  await ensureDir(dirname(opts.outputPath));
  const seedOutput: SeedIdsFile = {
    version: "v1",
    repo: opts.repo,
    manifestVersion: manifest.version,
    generatedAt: new Date().toISOString(),
    seedLabel: manifest.seedLabel,
    scenarios: {},
  };
  for (const scenario of manifest.scenarios) {
    const issue = slugToIssue.get(scenario.slug);
    if (!issue) continue;
    seedOutput.scenarios[scenario.slug] = {
      issue: { number: issue.number, url: issue.url, nodeId: issue.nodeId },
    };
  }
  await writeSeedIds(opts.outputPath, seedOutput);

  if (opts.verify) {
    const relationshipProvider = new GitHubRelationshipProvider(opts.repo, github);
    const errors: string[] = [];
    for (const scenario of manifest.scenarios) {
      const known = slugToIssue.get(scenario.slug);
      if (!known) {
        errors.push(`${scenario.slug}: missing issue`);
        continue;
      }
      const issue = await fetchIssue({ github, repo: opts.repo, number: known.number });
      if (!issue) {
        errors.push(`${scenario.slug}: missing issue`);
        continue;
      }
      const snapshot = await relationshipProvider.getSnapshot({ repo: opts.repo, number: issue.number });
      const scenarioErrors = buildVerificationErrors({
        manifest,
        scenario,
        issue,
        slugToRef,
        baseRepo: opts.repo,
        relationshipSnapshot: snapshot,
      });
      const requiredBlockedBy = scenario.capabilities?.blockedByApi ?? "best-effort";
      const requiredSubIssues = scenario.capabilities?.subIssuesApi ?? "best-effort";
      const filtered = scenarioErrors.filter((err) => {
        if (requiredBlockedBy !== "required" && err.includes("API blocked-by")) return false;
        if (requiredSubIssues !== "required" && err.includes("API sub-issue")) return false;
        return true;
      });
      if (filtered.length > 0) {
        for (const err of filtered) {
          errors.push(`${scenario.slug}: ${err}`);
        }
      }
    }
    if (errors.length > 0) {
      throw new Error(`Seed suite verification failed:\n- ${errors.join("\n- ")}`);
    }
  }

  console.log(`Seed suite complete. Output: ${opts.outputPath}`);
}
