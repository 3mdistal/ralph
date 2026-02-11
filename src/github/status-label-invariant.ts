import { shouldLog } from "../logging";
import { RALPH_LABEL_STATUS_IN_PROGRESS, RALPH_LABEL_STATUS_QUEUED, RALPH_STATUS_LABEL_PREFIX } from "../github-labels";
import { listTaskOpStatesByRepo } from "../state";
import { canAttemptLabelWrite, recordLabelWriteFailure, recordLabelWriteSuccess } from "./label-write-backoff";

type StatusInvariantIo = {
  listLabels: () => Promise<string[]>;
  addLabels: (labels: string[]) => Promise<void>;
  removeLabel: (label: string) => Promise<void>;
};

function isStatusLabel(label: string): boolean {
  return label.toLowerCase().startsWith(RALPH_STATUS_LABEL_PREFIX);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function inferActiveOwnership(repo: string, issueNumber: number): boolean {
  try {
    const opState = listTaskOpStatesByRepo(repo).find((entry) => entry.issueNumber === issueNumber);
    if (!opState) return false;
    return !(typeof opState.releasedAtMs === "number" && Number.isFinite(opState.releasedAtMs));
  } catch {
    return false;
  }
}

export function chooseStatusHealTarget(params: {
  repo: string;
  issueNumber: number;
  desiredHint?: string | null;
  activeOwnership?: boolean;
}): string {
  const hint = params.desiredHint?.trim();
  if (hint && isStatusLabel(hint)) return hint;
  const activeOwnership = params.activeOwnership ?? inferActiveOwnership(params.repo, params.issueNumber);
  return activeOwnership ? RALPH_LABEL_STATUS_IN_PROGRESS : RALPH_LABEL_STATUS_QUEUED;
}

export function countStatusLabels(labels: string[]): number {
  return labels.filter(isStatusLabel).length;
}

export async function enforceSingleStatusLabelInvariant(params: {
  repo: string;
  issueNumber: number;
  desiredHint?: string | null;
  io: StatusInvariantIo;
  activeOwnership?: boolean;
  logPrefix: string;
}): Promise<void> {
  const before = unique(await params.io.listLabels());
  const beforeStatus = before.filter(isStatusLabel);
  if (beforeStatus.length === 1) return;

  const target = chooseStatusHealTarget({
    repo: params.repo,
    issueNumber: params.issueNumber,
    desiredHint: params.desiredHint,
    activeOwnership: params.activeOwnership,
  });

  if (!canAttemptLabelWrite(params.repo)) {
    if (shouldLog(`status-heal:blocked:${params.repo}#${params.issueNumber}`, 60_000)) {
      console.warn(
        `${params.logPrefix} Status invariant check skipped for ${params.repo}#${params.issueNumber}; label writes blocked`
      );
    }
    return;
  }

  try {
    await params.io.addLabels([target]);
    for (const label of beforeStatus) {
      if (label === target) continue;
      await params.io.removeLabel(label);
    }
    recordLabelWriteSuccess(params.repo);

    if (shouldLog(`status-heal:applied:${params.repo}#${params.issueNumber}`, 60_000)) {
      console.warn(
        `${params.logPrefix} Healed status invariant for ${params.repo}#${params.issueNumber}: before=${beforeStatus.join(",") || "<none>"} target=${target}`
      );
    }
  } catch (error) {
    recordLabelWriteFailure(params.repo, error);
    if (shouldLog(`status-heal:error:${params.repo}#${params.issueNumber}`, 60_000)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `${params.logPrefix} Failed to heal status invariant for ${params.repo}#${params.issueNumber}: ${message}`
      );
    }
  }
}
