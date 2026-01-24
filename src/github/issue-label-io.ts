import { splitRepoFullName, type GitHubClient, type GitHubResponse } from "./client";

export type LabelOp = { action: "add" | "remove"; label: string };

type GitHubRequester = Pick<GitHubClient, "request">;

type LabelMutationOptions = {
  allowNonRalph?: boolean;
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
}): Promise<{ add: string[]; remove: string[]; ok: boolean }> {
  const added: string[] = [];
  const removed: string[] = [];
  const applied: LabelOp[] = [];
  const log = params.log ?? console.warn;
  const logLabel = params.logLabel ?? `${params.repo}#${params.issueNumber}`;

  for (const step of params.ops) {
    try {
      if (step.action === "add") {
        await addIssueLabel({
          github: params.github,
          repo: params.repo,
          issueNumber: params.issueNumber,
          label: step.label,
          allowNonRalph: params.allowNonRalph,
        });
        added.push(step.label);
        applied.push(step);
      } else {
        const result = await removeIssueLabel({
          github: params.github,
          repo: params.repo,
          issueNumber: params.issueNumber,
          label: step.label,
          allowNotFound: true,
          allowNonRalph: params.allowNonRalph,
        });
        if (result.removed) {
          removed.push(step.label);
          applied.push(step);
        }
      }
    } catch (error: any) {
      log(
        `[ralph:github:labels] Failed to ${step.action} ${step.label} for ${logLabel}: ${error?.message ?? String(error)}`
      );
      for (const rollback of [...applied].reverse()) {
        try {
          if (rollback.action === "add") {
            await removeIssueLabel({
              github: params.github,
              repo: params.repo,
              issueNumber: params.issueNumber,
              label: rollback.label,
              allowNotFound: true,
              allowNonRalph: params.allowNonRalph,
            });
          } else {
            await addIssueLabel({
              github: params.github,
              repo: params.repo,
              issueNumber: params.issueNumber,
              label: rollback.label,
              allowNonRalph: params.allowNonRalph,
            });
          }
        } catch {
          // best-effort rollback
        }
      }
      return { add: added, remove: removed, ok: false };
    }
  }

  return { add: added, remove: removed, ok: true };
}
