import { GitHubApiError, splitRepoFullName, type GitHubClient, type GitHubResponse } from "./client";
import type { EnsureOutcome } from "./ensure-ralph-workflow-labels";
import { canAttemptLabelWrite, recordLabelWriteFailure, recordLabelWriteSuccess } from "./label-write-backoff";
import { withIssueLabelLock } from "./issue-label-lock";
import { enforceSingleStatusLabelInvariant } from "./status-label-invariant";
import {
  RALPH_LABEL_STATUS_DONE,
  RALPH_LABEL_STATUS_IN_BOT,
  RALPH_STATUS_LABEL_PREFIX,
} from "../github-labels";
import { coalesceIssueLabelWrite } from "./write-coalescer";
import { shouldLog } from "../logging";
import { publishDashboardEvent } from "../dashboard/publisher";

export type LabelOp = { action: "add" | "remove"; label: string };

export type ApplyIssueLabelOpsResult =
  | { ok: true; add: string[]; remove: string[]; didRetry: boolean }
  | {
      ok: false;
      add: string[];
      remove: string[];
      didRetry: boolean;
      kind: "policy" | "auth" | "transient" | "unknown";
      error: unknown;
    };

type GitHubRequester = Pick<GitHubClient, "request">;

type LabelMutationOptions = {
  allowNonRalph?: boolean;
};

type LabelOpsIo = {
  addLabel: (label: string) => Promise<void>;
  addLabels?: (labels: string[]) => Promise<void>;
  removeLabel: (label: string) => Promise<{ removed?: boolean } | void>;
  listLabels?: () => Promise<string[]>;
};

type LabelWriteClass = "critical" | "important" | "best-effort";

type ApplyIssueLabelOpsParams = {
  ops: LabelOp[];
  io: LabelOpsIo;
  log?: (message: string) => void;
  logLabel?: string;
  repo?: string;
  allowNonRalph?: boolean;
  ensureLabels?: () => Promise<EnsureOutcome>;
  retryMissingLabelOnce?: boolean;
  ensureBefore?: boolean;
  issueNumber?: number;
  skipIssueLock?: boolean;
  writeClass?: LabelWriteClass;
  bypassCoalescing?: boolean;
  coalesceWindowMs?: number;
};

const DEFAULT_LABEL_WRITE_COALESCE_MS = 500;
const COALESCER_MAX_IDLE_MS = 60_000;
const ISSUE_WRITE_COOLDOWN_BASE_MS = 5_000;
const ISSUE_WRITE_COOLDOWN_MAX_MS = 5 * 60_000;

type CooldownState = {
  untilMs: number;
  failures: number;
};

type PendingLabelWrite = {
  params: ApplyIssueLabelOpsParams;
  ops: LabelOp[];
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Array<{
    resolve: (result: ApplyIssueLabelOpsResult) => void;
    reject: (error: unknown) => void;
  }>;
  lastTouchedMs: number;
};

const pendingLabelWritesByIssue = new Map<string, PendingLabelWrite>();
const issueLabelCooldownByKey = new Map<string, CooldownState>();

function readLabelCoalesceWindowMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(0, Math.floor(override));
  }
  const raw = process.env.RALPH_GITHUB_LABEL_WRITE_COALESCE_MS;
  if (raw === undefined) return DEFAULT_LABEL_WRITE_COALESCE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LABEL_WRITE_COALESCE_MS;
  return Math.max(0, Math.floor(parsed));
}

function classifyWriteClass(value: LabelWriteClass | undefined): LabelWriteClass {
  return value ?? "important";
}

function isCommandLabel(label: string): boolean {
  return label.trim().toLowerCase().startsWith("ralph:cmd:");
}

function canCoalesceLabelOps(params: ApplyIssueLabelOpsParams): boolean {
  if (params.bypassCoalescing) return false;
  if (classifyWriteClass(params.writeClass) !== "best-effort") return false;
  if (!params.repo || typeof params.issueNumber !== "number") return false;
  if (params.ops.some((op) => isCommandLabel(op.label))) return false;
  return readLabelCoalesceWindowMs(params.coalesceWindowMs) > 0;
}

function buildIssueWriteKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function isLikelyTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /timed out|timeout|abort/i.test(message);
}

function isTransientFailureResult(result: ApplyIssueLabelOpsResult): boolean {
  if (result.ok) return false;
  if (result.kind === "transient") return true;
  return isLikelyTimeoutError(result.error);
}

function nextIssueCooldownMs(previousFailures: number): number {
  const exp = Math.max(0, Math.min(12, previousFailures));
  return Math.min(ISSUE_WRITE_COOLDOWN_MAX_MS, ISSUE_WRITE_COOLDOWN_BASE_MS * 2 ** exp);
}

function emitWriteSuppressionTelemetry(params: {
  repo: string;
  issueNumber: number;
  reason: string;
  source: "coalesced" | "dropped-noop" | "suppressed-cooldown";
  detail?: string;
}): void {
  const issueKey = `${params.repo}#${params.issueNumber}`;
  if (!shouldLog(`label-write:${params.source}:${issueKey}`, 10_000)) return;
  const message = `[ralph:github:labels] ${issueKey} ${params.source} reason=${params.reason}${
    params.detail ? ` detail=${params.detail}` : ""
  }`;
  console.warn(message);
  publishDashboardEvent(
    {
      type: "log.ralph",
      level: "debug",
      data: { message },
    },
    { repo: params.repo }
  );
}

function cleanupStalePendingLabelWrites(nowMs: number): void {
  for (const [key, entry] of pendingLabelWritesByIssue.entries()) {
    if (entry.timer) continue;
    if (entry.waiters.length > 0) continue;
    if (nowMs - entry.lastTouchedMs < COALESCER_MAX_IDLE_MS) continue;
    pendingLabelWritesByIssue.delete(key);
  }
}

function mergeLabelOps(existing: LabelOp[], incoming: LabelOp[]): LabelOp[] {
  const actionByLabel = new Map<string, "add" | "remove">();
  const order: string[] = [];
  const push = (op: LabelOp) => {
    const label = normalizeLabel(op.label);
    if (!label) return;
    if (!actionByLabel.has(label)) order.push(label);
    actionByLabel.set(label, op.action);
  };
  for (const op of existing) push(op);
  for (const op of incoming) push(op);

  const add: string[] = [];
  const remove: string[] = [];
  for (const label of order) {
    const action = actionByLabel.get(label);
    if (action === "add") add.push(label);
    if (action === "remove") remove.push(label);
  }
  return planIssueLabelOps({ add, remove, allowNonRalph: true });
}

async function trimNoopLabelOpsAgainstLiveLabels(params: {
  ops: LabelOp[];
  io: LabelOpsIo;
}): Promise<LabelOp[]> {
  if (!params.io.listLabels) return params.ops;
  let labels: string[];
  try {
    labels = (await params.io.listLabels()).map((label) => normalizeLabel(label)).filter((label): label is string => Boolean(label));
  } catch {
    return params.ops;
  }
  const set = new Set(labels);
  const filtered: LabelOp[] = [];
  for (const op of params.ops) {
    if (op.action === "add") {
      if (set.has(op.label)) continue;
      set.add(op.label);
      filtered.push(op);
    } else {
      if (!set.has(op.label)) continue;
      set.delete(op.label);
      filtered.push(op);
    }
  }
  return filtered;
}

function getIssueCooldownState(issueKey: string): CooldownState | null {
  const state = issueLabelCooldownByKey.get(issueKey);
  if (!state) return null;
  if (state.untilMs <= Date.now()) {
    issueLabelCooldownByKey.delete(issueKey);
    return null;
  }
  return state;
}

function recordIssueWriteSuccess(issueKey: string): void {
  issueLabelCooldownByKey.delete(issueKey);
}

function recordIssueWriteFailure(issueKey: string): number {
  const existing = issueLabelCooldownByKey.get(issueKey) ?? { untilMs: 0, failures: 0 };
  const failures = existing.failures + 1;
  const cooldownMs = nextIssueCooldownMs(failures - 1);
  const untilMs = Date.now() + cooldownMs;
  issueLabelCooldownByKey.set(issueKey, { untilMs, failures });
  return untilMs;
}

async function enqueueCoalescedLabelWrite(params: ApplyIssueLabelOpsParams): Promise<ApplyIssueLabelOpsResult> {
  const repo = params.repo!;
  const issueNumber = params.issueNumber!;
  const issueKey = buildIssueWriteKey(repo, issueNumber);
  const windowMs = readLabelCoalesceWindowMs(params.coalesceWindowMs);
  const nowMs = Date.now();
  cleanupStalePendingLabelWrites(nowMs);

  const blocked = getIssueCooldownState(issueKey);
  if (blocked) {
    emitWriteSuppressionTelemetry({
      repo,
      issueNumber,
      reason: "cooldown-active",
      source: "suppressed-cooldown",
      detail: `until=${new Date(blocked.untilMs).toISOString()}`,
    });
    return {
      ok: false,
      add: [],
      remove: [],
      didRetry: false,
      kind: "transient",
      error: new Error(`Best-effort label writes cooling down until ${new Date(blocked.untilMs).toISOString()}`),
    };
  }

  let entry = pendingLabelWritesByIssue.get(issueKey);
  if (!entry) {
    entry = {
      params: { ...params },
      ops: [],
      timer: null,
      waiters: [],
      lastTouchedMs: nowMs,
    };
    pendingLabelWritesByIssue.set(issueKey, entry);
  }

  entry.params = { ...params };
  entry.ops = mergeLabelOps(entry.ops, params.ops);
  entry.lastTouchedMs = nowMs;

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
    emitWriteSuppressionTelemetry({
      repo,
      issueNumber,
      reason: "merged-into-pending-window",
      source: "coalesced",
      detail: `ops=${entry.ops.length}`,
    });
  }

  return await new Promise<ApplyIssueLabelOpsResult>((resolve, reject) => {
    entry!.waiters.push({ resolve, reject });
    entry!.timer = setTimeout(async () => {
      const current = pendingLabelWritesByIssue.get(issueKey);
      if (!current) return;
      current.timer = null;
      current.lastTouchedMs = Date.now();
      const waiters = current.waiters.splice(0, current.waiters.length);
      const ops = current.ops;
      current.ops = [];

      const flushParams: ApplyIssueLabelOpsParams = {
        ...current.params,
        ops,
        bypassCoalescing: true,
      };

      try {
        flushParams.ops = await trimNoopLabelOpsAgainstLiveLabels({ ops: flushParams.ops, io: flushParams.io });
        if (flushParams.ops.length === 0) {
          emitWriteSuppressionTelemetry({
            repo,
            issueNumber,
            reason: "live-noop",
            source: "dropped-noop",
          });
          const noop: ApplyIssueLabelOpsResult = { ok: true, add: [], remove: [], didRetry: false };
          for (const waiter of waiters) waiter.resolve(noop);
          return;
        }

        const result = await applyIssueLabelOpsNow(flushParams);
        if (result.ok) {
          recordIssueWriteSuccess(issueKey);
        } else if (isTransientFailureResult(result)) {
          const untilMs = recordIssueWriteFailure(issueKey);
          emitWriteSuppressionTelemetry({
            repo,
            issueNumber,
            reason: "transient-write-failure",
            source: "suppressed-cooldown",
            detail: `until=${new Date(untilMs).toISOString()}`,
          });
        }
        for (const waiter of waiters) waiter.resolve(result);
      } catch (error) {
        const untilMs = recordIssueWriteFailure(issueKey);
        emitWriteSuppressionTelemetry({
          repo,
          issueNumber,
          reason: "flush-threw",
          source: "suppressed-cooldown",
          detail: `until=${new Date(untilMs).toISOString()}`,
        });
        for (const waiter of waiters) waiter.reject(error);
      } finally {
        current.lastTouchedMs = Date.now();
      }
    }, windowMs);
  });
}

function isStatusLabel(label: string): boolean {
  return label.toLowerCase().startsWith(RALPH_STATUS_LABEL_PREFIX);
}

function firstStatusLabel(labels: string[]): string | null {
  for (const label of labels) {
    if (isStatusLabel(label)) return label;
  }
  return null;
}

export async function listIssueLabels(params: {
  github: GitHubRequester;
  repo: string;
  issueNumber: number;
}): Promise<string[]> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response: GitHubResponse<Array<{ name?: string }>> = await params.github.request(
    `/repos/${owner}/${name}/issues/${params.issueNumber}/labels`,
    {
      method: "GET",
    }
  );
  const labels = Array.isArray(response.data) ? response.data : [];
  return labels
    .map((entry) => normalizeLabel(entry?.name ?? ""))
    .filter((label): label is string => Boolean(label));
}

export function normalizeLabel(label: string): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed ? trimmed : null;
}

function assertRalphLabel(label: string, opts?: LabelMutationOptions): void {
  if (opts?.allowNonRalph) return;
  if (!label.toLowerCase().startsWith("ralph:")) {
    throw new Error(`Refusing to mutate non-Ralph label: ${label}`);
  }
}

function isRalphLabel(label: string): boolean {
  return label.toLowerCase().startsWith("ralph:");
}

function isMissingLabelError(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) return false;
  if (error.status !== 422) return false;
  return /label[^\n]*does not exist/i.test(error.responseText);
}

function isSecondaryRateLimit(error: GitHubApiError): boolean {
  const text = error.responseText.toLowerCase();
  return (
    text.includes("secondary rate limit") ||
    text.includes("abuse detection") ||
    text.includes("temporarily blocked")
  );
}

function classifyLabelOpError(error: unknown): "auth" | "transient" | "unknown" {
  if (!(error instanceof GitHubApiError)) return "unknown";
  if (error.status === 429 || error.code === "rate_limit" || isSecondaryRateLimit(error)) {
    return "transient";
  }
  if (error.status === 401 || error.status === 403 || error.code === "auth") {
    return "auth";
  }
  if (error.status === 404) {
    return "auth";
  }
  return "unknown";
}

function uniqueOrderedLabels(labels: string[], opts?: LabelMutationOptions): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    if (!normalized || seen.has(normalized)) continue;
    assertRalphLabel(normalized, opts);
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function planIssueLabelOps(params: {
  add: string[];
  remove: string[];
  allowNonRalph?: boolean;
}): LabelOp[] {
  const add = uniqueOrderedLabels(params.add, { allowNonRalph: params.allowNonRalph });
  const removeRaw = uniqueOrderedLabels(params.remove, { allowNonRalph: params.allowNonRalph });
  const addSet = new Set(add);
  const remove = removeRaw.filter((label) => !addSet.has(label));
  return [...add.map((label) => ({ action: "add" as const, label })), ...remove.map((label) => ({ action: "remove" as const, label }))];
}

export async function addIssueLabel(params: {
  github: GitHubRequester;
  repo: string;
  issueNumber: number;
  label: string;
  allowNonRalph?: boolean;
}): Promise<void> {
  const label = normalizeLabel(params.label);
  if (!label) return;
  assertRalphLabel(label, { allowNonRalph: params.allowNonRalph });
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/labels`, {
    method: "POST",
    body: { labels: [label] },
  });
}

export async function addIssueLabels(params: {
  github: GitHubRequester;
  repo: string;
  issueNumber: number;
  labels: string[];
  allowNonRalph?: boolean;
}): Promise<void> {
  const labels = uniqueOrderedLabels(params.labels, { allowNonRalph: params.allowNonRalph });
  if (labels.length === 0) return;
  const { owner, name } = splitRepoFullName(params.repo);
  await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/labels`, {
    method: "POST",
    body: { labels },
  });
}

export async function removeIssueLabel(params: {
  github: GitHubRequester;
  repo: string;
  issueNumber: number;
  label: string;
  allowNotFound?: boolean;
  allowNonRalph?: boolean;
}): Promise<{ removed: boolean }> {
  const label = normalizeLabel(params.label);
  if (!label) return { removed: false };
  const allowNotFound = params.allowNotFound ?? true;
  assertRalphLabel(label, { allowNonRalph: params.allowNonRalph });
  const { owner, name } = splitRepoFullName(params.repo);
  const response: GitHubResponse<unknown> = await params.github.request(
    `/repos/${owner}/${name}/issues/${params.issueNumber}/labels/${encodeURIComponent(label)}`,
    {
      method: "DELETE",
      allowNotFound,
    }
  );
  // Treat label absence as already removed when allowNotFound is enabled.
  // This is critical for convergence: callers rely on `removed` to update local label snapshots.
  if (response.status === 404) return { removed: allowNotFound };
  return { removed: true };
}

export async function executeIssueLabelOps(params: {
  github: GitHubRequester;
  repo: string;
  issueNumber: number;
  ops: LabelOp[];
  log?: (message: string) => void;
  logLabel?: string;
  allowNonRalph?: boolean;
  ensureLabels?: () => Promise<EnsureOutcome>;
  retryMissingLabelOnce?: boolean;
  ensureBefore?: boolean;
  writeClass?: LabelWriteClass;
  coalesceWindowMs?: number;
}): Promise<ApplyIssueLabelOpsResult> {
  const add = params.ops.filter((op) => op.action === "add").map((op) => op.label);
  const remove = params.ops.filter((op) => op.action === "remove").map((op) => op.label);
  if (add.length === 0 && remove.length === 0) {
    console.log(
      `[ralph:telemetry:${params.repo}] github.write.dropped ${JSON.stringify({
        kind: "labels",
        repo: params.repo,
        issueNumber: params.issueNumber,
        reason: "noop",
        source: params.logLabel ?? null,
      })}`
    );
    return { ok: true, add: [], remove: [], didRetry: false };
  }

  const containsCmdLabel = params.ops.some((op) => op.label.toLowerCase().startsWith("ralph:cmd:"));
  const critical = add.includes(RALPH_LABEL_STATUS_IN_BOT) || add.includes(RALPH_LABEL_STATUS_DONE);

  const run = async () =>
    await withIssueLabelLock({
      repo: params.repo,
      issueNumber: params.issueNumber,
      run: async () => {
      const result = await applyIssueLabelOps({
        ops: params.ops,
        io: {
          addLabels: async (labels) =>
            await addIssueLabels({
              github: params.github,
              repo: params.repo,
              issueNumber: params.issueNumber,
              labels,
              allowNonRalph: params.allowNonRalph,
            }),
          addLabel: async (label) =>
            await addIssueLabel({
              github: params.github,
              repo: params.repo,
              issueNumber: params.issueNumber,
              label,
              allowNonRalph: params.allowNonRalph,
            }),
          removeLabel: async (label) =>
            await removeIssueLabel({
              github: params.github,
              repo: params.repo,
              issueNumber: params.issueNumber,
              label,
              allowNotFound: true,
              allowNonRalph: params.allowNonRalph,
            }),
        },
        log: params.log,
        logLabel: params.logLabel ?? `${params.repo}#${params.issueNumber}`,
        repo: params.repo,
        issueNumber: params.issueNumber,
        allowNonRalph: params.allowNonRalph,
        ensureLabels: params.ensureLabels,
        retryMissingLabelOnce: params.retryMissingLabelOnce,
        ensureBefore: params.ensureBefore,
        writeClass: params.writeClass,
        coalesceWindowMs: params.coalesceWindowMs,
        skipIssueLock: true,
      });

      if (!result.ok) return result;

      const statusTouched = params.ops.some((op) => isStatusLabel(op.label));
      if (!statusTouched) return result;

      await enforceSingleStatusLabelInvariant({
        repo: params.repo,
        issueNumber: params.issueNumber,
        desiredHint: firstStatusLabel(result.add),
        logPrefix: "[ralph:github:labels]",
        io: {
          listLabels: async () => await listIssueLabels({ github: params.github, repo: params.repo, issueNumber: params.issueNumber }),
          addLabels: async (labels) =>
            await addIssueLabels({
              github: params.github,
              repo: params.repo,
              issueNumber: params.issueNumber,
              labels,
              allowNonRalph: params.allowNonRalph,
            }),
          removeLabel: async (label) => {
            await removeIssueLabel({
              github: params.github,
              repo: params.repo,
              issueNumber: params.issueNumber,
              label,
              allowNotFound: true,
              allowNonRalph: params.allowNonRalph,
            });
          },
        },
      });

      return result;
    },
    });

  if (containsCmdLabel) {
    return await run();
  }

  return await coalesceIssueLabelWrite({
    repo: params.repo,
    issueNumber: params.issueNumber,
    add,
    remove,
    source: params.logLabel,
    critical,
    run,
  });
}

export async function applyIssueLabelOps(params: ApplyIssueLabelOpsParams): Promise<ApplyIssueLabelOpsResult> {
  if (canCoalesceLabelOps(params)) {
    return await enqueueCoalescedLabelWrite(params);
  }
  return await applyIssueLabelOpsNow(params);
}

async function applyIssueLabelOpsNow(params: ApplyIssueLabelOpsParams): Promise<ApplyIssueLabelOpsResult> {
  if (!params.skipIssueLock && params.repo && typeof params.issueNumber === "number") {
    return await withIssueLabelLock({
      repo: params.repo,
      issueNumber: params.issueNumber,
      run: async () => await applyIssueLabelOpsNow({ ...params, skipIssueLock: true }),
    });
  }

  const added: string[] = [];
  const removed: string[] = [];
  const applied: LabelOp[] = [];
  const log = params.log ?? console.warn;
  const logLabel = params.logLabel ?? "issue";
  const allowNonRalph = params.allowNonRalph ?? false;
  const retryMissingLabelOnce = params.retryMissingLabelOnce ?? Boolean(params.ensureLabels);
  let lastEnsureOutcome: EnsureOutcome | null = null;

  if (params.repo && !canAttemptLabelWrite(params.repo)) {
    return {
      ok: false,
      add: added,
      remove: removed,
      didRetry: false,
      kind: "transient",
      error: new Error("GitHub label writes temporarily blocked"),
    };
  }

  if (!allowNonRalph) {
    for (const step of params.ops) {
      if (!isRalphLabel(step.label)) {
        const error = new Error(`Refusing to mutate non-Ralph label: ${step.label}`);
        return { ok: false, add: [], remove: [], didRetry: false, kind: "policy", error };
      }
    }
  }

  if (params.ensureBefore && params.ensureLabels) {
    try {
      lastEnsureOutcome = await params.ensureLabels();
    } catch (error) {
      lastEnsureOutcome = { ok: false, kind: "transient", error };
    }
    if (lastEnsureOutcome && !lastEnsureOutcome.ok && lastEnsureOutcome.kind === "transient" && params.repo) {
      recordLabelWriteFailure(params.repo, lastEnsureOutcome.error);
    }
  }

  const applyOnce = async (didRetry: boolean): Promise<ApplyIssueLabelOpsResult> => {
    const addSteps = params.ops.filter((step) => step.action === "add");
    const removeSteps = params.ops.filter((step) => step.action === "remove");

    const addLabels = addSteps.map((step) => step.label);
    if (addLabels.length > 1 && params.io.addLabels) {
      try {
        await params.io.addLabels(addLabels);
        for (const label of addLabels) {
          added.push(label);
        }
        for (const step of addSteps) {
          applied.push(step);
        }
      } catch (error: any) {
        log(
          `[ralph:github:labels] Failed to add labels for ${logLabel}: ${error?.message ?? String(error)}`
        );
        if (!didRetry && retryMissingLabelOnce && isMissingLabelError(error) && params.ensureLabels) {
          if (lastEnsureOutcome && !lastEnsureOutcome.ok && lastEnsureOutcome.kind === "auth") {
            return { ok: false, add: added, remove: removed, didRetry: true, kind: "auth", error: lastEnsureOutcome.error };
          }
          lastEnsureOutcome = await params.ensureLabels();
          if (!lastEnsureOutcome.ok) {
            return {
              ok: false,
              add: added,
              remove: removed,
              didRetry: true,
              kind: lastEnsureOutcome.kind,
              error: lastEnsureOutcome.error,
            };
          }
          return await applyOnce(true);
        }

        const kind = classifyLabelOpError(error);
        if (params.repo && kind === "transient") {
          recordLabelWriteFailure(params.repo, error);
        }
        return {
          ok: false,
          add: added,
          remove: removed,
          didRetry,
          kind,
          error,
        };
      }
    } else {
      for (const step of addSteps) {
        try {
          await params.io.addLabel(step.label);
          added.push(step.label);
          applied.push(step);
        } catch (error: any) {
          log(
            `[ralph:github:labels] Failed to ${step.action} ${step.label} for ${logLabel}: ${
              error?.message ?? String(error)
            }`
          );
          if (!didRetry && retryMissingLabelOnce && isMissingLabelError(error) && params.ensureLabels) {
            if (lastEnsureOutcome && !lastEnsureOutcome.ok && lastEnsureOutcome.kind === "auth") {
              return { ok: false, add: added, remove: removed, didRetry: true, kind: "auth", error: lastEnsureOutcome.error };
            }
            lastEnsureOutcome = await params.ensureLabels();
            if (!lastEnsureOutcome.ok) {
              return {
                ok: false,
                add: added,
                remove: removed,
                didRetry: true,
                kind: lastEnsureOutcome.kind,
                error: lastEnsureOutcome.error,
              };
            }
            return await applyOnce(true);
          }

          const kind = classifyLabelOpError(error);
          if (params.repo && kind === "transient") {
            recordLabelWriteFailure(params.repo, error);
          } else if (kind !== "transient") {
            for (const rollback of [...applied].reverse()) {
              try {
                if (rollback.action === "add") {
                  await params.io.removeLabel(rollback.label);
                } else {
                  await params.io.addLabel(rollback.label);
                }
              } catch {
                // best-effort rollback
              }
            }
          }

          return {
            ok: false,
            add: added,
            remove: removed,
            didRetry,
            kind,
            error,
          };
        }
      }
    }

    for (const step of removeSteps) {
      try {
        const result = await params.io.removeLabel(step.label);
        if (result && "removed" in result && !result.removed) {
          continue;
        }
        removed.push(step.label);
        applied.push(step);
      } catch (error: any) {
        log(
          `[ralph:github:labels] Failed to ${step.action} ${step.label} for ${logLabel}: ${
            error?.message ?? String(error)
          }`
        );
        const kind = classifyLabelOpError(error);
        if (params.repo && kind === "transient") {
          recordLabelWriteFailure(params.repo, error);
        } else if (kind !== "transient") {
          for (const rollback of [...applied].reverse()) {
            try {
              if (rollback.action === "add") {
                await params.io.removeLabel(rollback.label);
              } else {
                await params.io.addLabel(rollback.label);
              }
            } catch {
              // best-effort rollback
            }
          }
        }

        return {
          ok: false,
          add: added,
          remove: removed,
          didRetry,
          kind,
          error,
        };
      }
    }

    if (params.repo) {
      recordLabelWriteSuccess(params.repo);
    }
    return { ok: true, add: added, remove: removed, didRetry };
  };

  return await applyOnce(false);
}
