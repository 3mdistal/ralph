import { getIssueLabels, recordIssueLabelsSnapshot } from "../state";
import { applyIssueLabelOps, type ApplyIssueLabelOpsResult, type LabelOp } from "./issue-label-io";
import type { EnsureOutcome } from "./ensure-ralph-workflow-labels";

export type LabelWritebackIo = {
  mutateIssueLabels: (params: {
    repo: string;
    issueNumber: number;
    issueNodeId?: string | null;
    add: string[];
    remove: string[];
  }) => Promise<boolean>;
  addIssueLabel: (repo: string, issueNumber: number, label: string) => Promise<void>;
  addIssueLabels?: (repo: string, issueNumber: number, labels: string[]) => Promise<void>;
  removeIssueLabel: (repo: string, issueNumber: number, label: string) => Promise<{ removed: boolean } | void>;
};

function recordLabelDeltaSnapshot(params: {
  repo: string;
  issueNumber: number;
  add: string[];
  remove: string[];
  nowIso: string;
}): void {
  const current = getIssueLabels(params.repo, params.issueNumber);
  const set = new Set(current);
  for (const label of params.remove) set.delete(label);
  for (const label of params.add) set.add(label);

  recordIssueLabelsSnapshot({
    repo: params.repo,
    issue: `${params.repo}#${params.issueNumber}`,
    labels: Array.from(set),
    at: params.nowIso,
  });
}

export async function applyIssueLabelWriteback(params: {
  io: LabelWritebackIo;
  repo: string;
  issueNumber: number;
  issueNodeId?: string | null;
  add: string[];
  remove: string[];
  nowIso: string;
  logLabel?: string;
  log?: (message: string) => void;
  ensureLabels?: () => Promise<EnsureOutcome>;
  allowNonRalph?: boolean;
}): Promise<
  | { ok: true; add: string[]; remove: string[]; didMutate: boolean }
  | { ok: false; add: string[]; remove: string[]; didMutate: boolean; result: ApplyIssueLabelOpsResult }
> {
  if (params.add.length === 0 && params.remove.length === 0) {
    return { ok: true, add: [], remove: [], didMutate: true };
  }

  const didMutate = await params.io.mutateIssueLabels({
    repo: params.repo,
    issueNumber: params.issueNumber,
    issueNodeId: params.issueNodeId,
    add: params.add,
    remove: params.remove,
  });
  if (didMutate) {
    recordLabelDeltaSnapshot({
      repo: params.repo,
      issueNumber: params.issueNumber,
      add: params.add,
      remove: params.remove,
      nowIso: params.nowIso,
    });
    return { ok: true, add: params.add, remove: params.remove, didMutate: true };
  }

  const steps: LabelOp[] = [
    ...params.add.map((label) => ({ action: "add" as const, label })),
    ...params.remove.map((label) => ({ action: "remove" as const, label })),
  ];
  const result = await applyIssueLabelOps({
    ops: steps,
    io: {
      addLabel: async (label: string) => await params.io.addIssueLabel(params.repo, params.issueNumber, label),
      addLabels: params.io.addIssueLabels
        ? async (labels: string[]) => await params.io.addIssueLabels?.(params.repo, params.issueNumber, labels)
        : undefined,
      removeLabel: async (label: string) =>
        await params.io.removeIssueLabel(params.repo, params.issueNumber, label),
    },
    logLabel: params.logLabel ?? `${params.repo}#${params.issueNumber}`,
    log: params.log ?? ((message) => console.warn(`[ralph:labels] ${message}`)),
    repo: params.repo,
    ensureLabels: params.ensureLabels,
    retryMissingLabelOnce: Boolean(params.ensureLabels),
    allowNonRalph: params.allowNonRalph,
  });

  if (result.ok) {
    recordLabelDeltaSnapshot({
      repo: params.repo,
      issueNumber: params.issueNumber,
      add: result.add,
      remove: result.remove,
      nowIso: params.nowIso,
    });
    return { ok: true, add: result.add, remove: result.remove, didMutate: false };
  }

  return { ok: false, add: result.add, remove: result.remove, didMutate: false, result };
}
