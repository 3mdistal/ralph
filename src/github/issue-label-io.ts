import { GitHubApiError, splitRepoFullName, type GitHubClient, type GitHubResponse } from "./client";
import type { EnsureOutcome } from "./ensure-ralph-workflow-labels";
import { canAttemptLabelWrite, recordLabelWriteFailure, recordLabelWriteSuccess } from "./label-write-backoff";
import { withIssueLabelLock } from "./issue-label-lock";
import { enforceSingleStatusLabelInvariant } from "./status-label-invariant";
import { RALPH_STATUS_LABEL_PREFIX } from "../github-labels";

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
};

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
};

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
}): Promise<ApplyIssueLabelOpsResult> {
  return await withIssueLabelLock({
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
}

export async function applyIssueLabelOps(params: ApplyIssueLabelOpsParams): Promise<ApplyIssueLabelOpsResult> {
  if (!params.skipIssueLock && params.repo && typeof params.issueNumber === "number") {
    return await withIssueLabelLock({
      repo: params.repo,
      issueNumber: params.issueNumber,
      run: async () => await applyIssueLabelOps({ ...params, skipIssueLock: true }),
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
