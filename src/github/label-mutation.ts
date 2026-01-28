import { GitHubClient, type GitHubResponse } from "./client";
import { canAttemptLabelWrite, recordLabelWriteFailure, recordLabelWriteSuccess } from "./label-write-backoff";
import { normalizeLabel } from "./issue-label-io";

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
}): Promise<LabelMutationResult> {
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
  });

  if (labelIds.size === 0) return { ok: false, error: new Error("Missing label ids") };

  const addIds = add.map((label) => labelIds.get(label)).filter((id): id is string => Boolean(id));
  const removeIds = remove.map((label) => labelIds.get(label)).filter((id): id is string => Boolean(id));

  if (addIds.length === 0 && removeIds.length === 0) return { ok: false, error: new Error("Missing label ids") };

  try {
    if (addIds.length > 0) {
      await params.github.request("/graphql", {
        method: "POST",
        body: {
          query: "mutation($labelableId: ID!, $labelIds: [ID!]!) { addLabelsToLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) { clientMutationId } }",
          variables: { labelableId: nodeId, labelIds: addIds },
        },
      });
    }
    if (removeIds.length > 0) {
      await params.github.request("/graphql", {
        method: "POST",
        body: {
          query: "mutation($labelableId: ID!, $labelIds: [ID!]!) { removeLabelsFromLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) { clientMutationId } }",
          variables: { labelableId: nodeId, labelIds: removeIds },
        },
      });
    }
    recordLabelWriteSuccess(params.repo);
    return { ok: true };
  } catch (error) {
    recordLabelWriteFailure(params.repo, error);
    return { ok: false, error };
  }
}

async function resolveLabelIds(params: {
  github: GitHubClient;
  repo: string;
  labels: string[];
  cache?: LabelIdCache;
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
