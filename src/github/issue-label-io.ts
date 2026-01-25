import { GitHubApiError, splitRepoFullName, type GitHubClient, type GitHubResponse } from "./client";
import type { EnsureOutcome } from "./ensure-ralph-workflow-labels";

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
  removeLabel: (label: string) => Promise<{ removed?: boolean } | void>;
};

type ApplyIssueLabelOpsParams = {
  ops: LabelOp[];
  io: LabelOpsIo;
  log?: (message: string) => void;
  logLabel?: string;
  allowNonRalph?: boolean;
  ensureLabels?: () => Promise<EnsureOutcome>;
  retryMissingLabelOnce?: boolean;
  ensureBefore?: boolean;
};

function normalizeLabel(label: string): string | null {
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
  assertRalphLabel(label, { allowNonRalph: params.allowNonRalph });
  const { owner, name } = splitRepoFullName(params.repo);
  const response: GitHubResponse<unknown> = await params.github.request(
    `/repos/${owner}/${name}/issues/${params.issueNumber}/labels/${encodeURIComponent(label)}`,
    {
      method: "DELETE",
      allowNotFound: params.allowNotFound ?? true,
    }
  );
  return { removed: response.status !== 404 };
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
  return await applyIssueLabelOps({
    ops: params.ops,
    io: {
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
    allowNonRalph: params.allowNonRalph,
    ensureLabels: params.ensureLabels,
    retryMissingLabelOnce: params.retryMissingLabelOnce,
    ensureBefore: params.ensureBefore,
  });
}

export async function applyIssueLabelOps(params: ApplyIssueLabelOpsParams): Promise<ApplyIssueLabelOpsResult> {
  const added: string[] = [];
  const removed: string[] = [];
  const applied: LabelOp[] = [];
  const log = params.log ?? console.warn;
  const logLabel = params.logLabel ?? "issue";
  const allowNonRalph = params.allowNonRalph ?? false;
  const retryMissingLabelOnce = params.retryMissingLabelOnce ?? Boolean(params.ensureLabels);
  let lastEnsureOutcome: EnsureOutcome | null = null;

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
  }

  const applyOnce = async (didRetry: boolean): Promise<ApplyIssueLabelOpsResult> => {
    for (const step of params.ops) {
      try {
        if (step.action === "add") {
          await params.io.addLabel(step.label);
          added.push(step.label);
          applied.push(step);
        } else {
          const result = await params.io.removeLabel(step.label);
          if (result && "removed" in result && !result.removed) {
            continue;
          }
          removed.push(step.label);
          applied.push(step);
        }
      } catch (error: any) {
        log(
          `[ralph:github:labels] Failed to ${step.action} ${step.label} for ${logLabel}: ${
            error?.message ?? String(error)
          }`
        );
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

        return {
          ok: false,
          add: added,
          remove: removed,
          didRetry,
          kind: classifyLabelOpError(error),
          error,
        };
      }
    }

    return { ok: true, add: added, remove: removed, didRetry };
  };

  return await applyOnce(false);
}
