import { computeRalphLabelSync } from "../github-labels";
import { shouldLog } from "../logging";
import { GitHubApiError, GitHubClient } from "./client";

export type EnsureOutcome =
  | { ok: true; created: string[]; updated: string[] }
  | { ok: false; kind: "auth" | "transient"; error: unknown };

type EnsureParams = {
  repo: string;
  github: GitHubClient;
};

type EnsureFactoryParams = {
  githubFactory: (repo: string) => GitHubClient;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  shouldLog?: (key: string, intervalMs: number) => boolean;
};

const AUTH_SCOPE_GUIDANCE =
  "Ensure the GitHub token can manage labels (PAT: repo scope or fine-grained Issues read/write + Metadata read; GitHub App: Issues read/write + Metadata read).";

function classifyEnsureError(error: unknown): "auth" | "transient" {
  if (error instanceof GitHubApiError && (error.code === "auth" || error.status === 401 || error.status === 403)) {
    return "auth";
  }
  return "transient";
}

function formatEnsureErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error instanceof GitHubApiError && error.status === 422 && /already exists/i.test(error.responseText)
  );
}

export async function ensureRalphWorkflowLabelsOnce(params: EnsureParams): Promise<EnsureOutcome> {
  let existing;
  try {
    existing = await params.github.listLabelSpecs();
  } catch (error) {
    return { ok: false, kind: classifyEnsureError(error), error };
  }

  const { toCreate, toUpdate } = computeRalphLabelSync(existing);
  if (toCreate.length === 0 && toUpdate.length === 0) {
    return { ok: true, created: [], updated: [] };
  }

  const created: string[] = [];
  for (const label of toCreate) {
    try {
      await params.github.createLabel(label);
      created.push(label.name);
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      return { ok: false, kind: classifyEnsureError(error), error };
    }
  }

  const updated: string[] = [];
  for (const update of toUpdate) {
    try {
      await params.github.updateLabel(update.currentName, update.patch);
      updated.push(update.currentName);
    } catch (error) {
      return { ok: false, kind: classifyEnsureError(error), error };
    }
  }

  return { ok: true, created, updated };
}

export function createRalphWorkflowLabelsEnsurer(params: EnsureFactoryParams): {
  ensure: (repo: string) => Promise<EnsureOutcome>;
} {
  const cache = new Map<string, EnsureOutcome>();
  const inFlight = new Map<string, Promise<EnsureOutcome>>();
  const log = params.log ?? ((message: string) => console.log(message));
  const warn = params.warn ?? ((message: string) => console.warn(message));
  const shouldLogFn = params.shouldLog ?? shouldLog;

  const warnAuth = (repo: string, error: unknown) => {
    if (!shouldLogFn(`ralph:labels:auth:${repo}`, 60_000)) return;
    warn(
      `[ralph:labels:${repo}] GitHub label bootstrap failed due to permissions: ${formatEnsureErrorMessage(error)}`
    );
    warn(`[ralph:labels:${repo}] ${AUTH_SCOPE_GUIDANCE}`);
  };

  const warnTransient = (repo: string, error: unknown) => {
    if (!shouldLogFn(`ralph:labels:transient:${repo}`, 60_000)) return;
    warn(`[ralph:labels:${repo}] GitHub label bootstrap failed: ${formatEnsureErrorMessage(error)}`);
  };

  const ensure = async (repo: string): Promise<EnsureOutcome> => {
    const cached = cache.get(repo);
    if (cached) return cached;

    const existing = inFlight.get(repo);
    if (existing) return existing;

    const promise = (async () => {
      const outcome = await ensureRalphWorkflowLabelsOnce({ repo, github: params.githubFactory(repo) });

      if (outcome.ok) {
        if (outcome.created.length > 0) {
          log(`[ralph:labels:${repo}] Created GitHub label(s): ${outcome.created.join(", ")}`);
        }
        if (outcome.updated.length > 0) {
          log(`[ralph:labels:${repo}] Updated GitHub label(s): ${outcome.updated.join(", ")}`);
        }
        cache.set(repo, outcome);
      } else if (outcome.kind === "auth") {
        warnAuth(repo, outcome.error);
        cache.set(repo, outcome);
      } else {
        warnTransient(repo, outcome.error);
      }

      return outcome;
    })();

    inFlight.set(repo, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(repo);
    }
  };

  return { ensure };
}
