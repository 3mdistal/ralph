import { GitHubClient, type GitHubResponse } from "./client";
import { canAttemptLabelWrite, recordLabelWriteFailure, recordLabelWriteSuccess } from "./label-write-backoff";
import { addIssueLabels, listIssueLabels, normalizeLabel, removeIssueLabel } from "./issue-label-io";
import { withIssueLabelLock } from "./issue-label-lock";
import { enforceSingleStatusLabelInvariant } from "./status-label-invariant";
import { RALPH_STATUS_LABEL_PREFIX } from "../github-labels";

type LabelIdCache = Map<string, string>;

export type LabelMutationResult = { ok: true } | { ok: false; error: unknown };

type LabelMutationPlan = {
  add: string[];
  remove: string[];
};

export async function mutateIssueLabels(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  issueNodeId?: string | null;
  plan: LabelMutationPlan;
  labelIdCache?: LabelIdCache;
  /** Optional caller tag for github.request telemetry. */
  telemetrySource?: string;
}): Promise<LabelMutationResult> {
  return await withIssueLabelLock({
    repo: params.repo,
    issueNumber: params.issueNumber,
    run: async () => {
      if (!canAttemptLabelWrite(params.repo)) {
        return { ok: false, error: new Error("GitHub label writes temporarily blocked") };
      }
      const add = params.plan.add.map(normalizeLabel).filter((label): label is string => Boolean(label));
      const remove = params.plan.remove.map(normalizeLabel).filter((label): label is string => Boolean(label));

      if (add.length === 0 && remove.length === 0) return { ok: true };

      const nodeId = params.issueNodeId?.trim();
      if (!nodeId) return { ok: false, error: new Error("Missing issue node id") };

      const labelIds = await resolveLabelIds({
        github: params.github,
        repo: params.repo,
        labels: [...new Set([...add, ...remove])],
        cache: params.labelIdCache,
        telemetrySource: params.telemetrySource,
      });

      if (labelIds.size === 0) return { ok: false, error: new Error("Missing label ids") };

      const addIds = add.map((label) => labelIds.get(label)).filter((id): id is string => Boolean(id));
      const removeIds = remove.map((label) => labelIds.get(label)).filter((id): id is string => Boolean(id));

      if (addIds.length === 0 && removeIds.length === 0) return { ok: false, error: new Error("Missing label ids") };

      try {
        if (addIds.length > 0) {
          await params.github.request("/graphql", {
            method: "POST",
            source: params.telemetrySource,
            body: {
              query: "mutation($labelableId: ID!, $labelIds: [ID!]!) { addLabelsToLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) { clientMutationId } }",
              variables: { labelableId: nodeId, labelIds: addIds },
            },
          });
        }
        if (removeIds.length > 0) {
          await params.github.request("/graphql", {
            method: "POST",
            source: params.telemetrySource,
            body: {
              query: "mutation($labelableId: ID!, $labelIds: [ID!]!) { removeLabelsFromLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) { clientMutationId } }",
              variables: { labelableId: nodeId, labelIds: removeIds },
            },
          });
        }
        recordLabelWriteSuccess(params.repo);

        const desiredStatusLabel = add.find((label) => label.toLowerCase().startsWith(RALPH_STATUS_LABEL_PREFIX));
        const statusTouched = add.concat(remove).some((label) => label.toLowerCase().startsWith(RALPH_STATUS_LABEL_PREFIX));
        if (statusTouched) {
          await enforceSingleStatusLabelInvariant({
            repo: params.repo,
            issueNumber: params.issueNumber,
            desiredHint: desiredStatusLabel,
            logPrefix: "[ralph:github:labels]",
            io: {
              listLabels: async () => await listIssueLabels({ github: params.github, repo: params.repo, issueNumber: params.issueNumber }),
              addLabels: async (labels) =>
                await addIssueLabels({ github: params.github, repo: params.repo, issueNumber: params.issueNumber, labels }),
              removeLabel: async (label) => {
                await removeIssueLabel({ github: params.github, repo: params.repo, issueNumber: params.issueNumber, label, allowNotFound: true });
              },
            },
          });
        }

        return { ok: true };
      } catch (error) {
        recordLabelWriteFailure(params.repo, error);
        return { ok: false, error };
      }
    },
  });
}

async function resolveLabelIds(params: {
  github: GitHubClient;
  repo: string;
  labels: string[];
  cache?: LabelIdCache;
  telemetrySource?: string;
}): Promise<Map<string, string>> {
  const cache = params.cache ?? new Map<string, string>();
  const remaining = params.labels.filter((label) => !cache.has(label));
  if (remaining.length === 0) return cache;

  const [owner, name] = params.repo.split("/");
  if (!owner || !name) return cache;

  const response: GitHubResponse<{
    data?: {
      repository?: { labels?: { nodes?: Array<{ name?: string | null; id?: string | null }> } };
    };
  }> = await params.github.request("/graphql", {
    method: "POST",
    source: params.telemetrySource,
    body: {
      query: "query($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { labels(first: $first) { nodes { id name } } } }",
      variables: { owner, name, first: 100 },
    },
  });

  const nodes = response.data?.data?.repository?.labels?.nodes ?? [];
  for (const node of nodes) {
    const name = normalizeLabel(node?.name ?? "");
    const id = typeof node?.id === "string" ? node.id : "";
    if (name && id) {
      cache.set(name, id);
    }
  }

  return cache;
}
