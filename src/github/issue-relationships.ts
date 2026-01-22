import { GitHubApiError, GitHubClient, splitRepoFullName } from "./client";
import { GitHubApiError, GitHubClient, splitRepoFullName } from "./client";
import {
  type IssueRef,
  type RelationshipSignal,
  parseIssueBodyDependencies,
} from "./issue-blocking-core";

export type IssueRelationshipSnapshot = {
  issue: IssueRef;
  signals: RelationshipSignal[];
  coverage: {
    githubDeps: boolean;
    githubSubIssues: boolean;
    bodyDeps: boolean;
  };
};

export interface IssueRelationshipProvider {
  getSnapshot(issue: IssueRef): Promise<IssueRelationshipSnapshot>;
}

type RelationshipCapability = "unknown" | "rest" | "graphql" | "unavailable";

type IssueBasics = {
  body: string;
};

type RestIssue = {
  number?: number | null;
  state?: string | null;
  repository?: { full_name?: string | null; nameWithOwner?: string | null } | null;
};

type RestIssueResponse = RestIssue | { node?: RestIssue | null } | null;

type GraphIssueRef = {
  number?: number | null;
  state?: string | null;
  repository?: { nameWithOwner?: string | null } | null;
};

type GraphConnection = {
  nodes?: Array<GraphIssueRef | null> | null;
};

type GraphIssue = {
  blockedBy?: GraphConnection | null;
  subIssues?: GraphConnection | null;
};

type GraphRepo = {
  issue?: GraphIssue | null;
};

type GraphResponse = {
  data?: { repository?: GraphRepo | null } | null;
  errors?: Array<{ message?: string | null }> | null;
};

type IssueStateRef = IssueRef & { state: "open" | "closed" | "unknown" };

const REST_DEPENDENCIES_PATH = (owner: string, repo: string, number: number) =>
  `/repos/${owner}/${repo}/issues/${number}/dependencies`;
const REST_SUB_ISSUES_PATH = (owner: string, repo: string, number: number) =>
  `/repos/${owner}/${repo}/issues/${number}/sub_issues`;

const GRAPH_BLOCKED_BY_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        blockedBy(first: 100) {
          nodes {
            number
            state
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`;

const GRAPH_SUB_ISSUES_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        subIssues(first: 100) {
          nodes {
            number
            state
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`;

function normalizeIssueState(state?: string | null): "open" | "closed" | "unknown" {
  const normalized = (state ?? "").toUpperCase();
  if (normalized === "OPEN") return "open";
  if (normalized === "CLOSED") return "closed";
  return "unknown";
}

function toIssueStateRef(raw: RestIssueResponse, baseRepo: string): IssueStateRef | null {
  const issue = (raw && typeof raw === "object" && "node" in raw ? raw.node : raw) as RestIssue | null;
  if (!issue) return null;
  const number = typeof issue.number === "number" ? issue.number : null;
  if (!number) return null;
  const repo = issue.repository?.nameWithOwner ?? issue.repository?.full_name ?? baseRepo;
  if (!repo) return null;
  return { repo, number, state: normalizeIssueState(issue.state) };
}

function extractIssueArray(raw: unknown, baseRepo: string): IssueStateRef[] | null {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { nodes?: unknown })?.nodes)
      ? (raw as { nodes?: unknown[] }).nodes
      : Array.isArray((raw as { edges?: unknown })?.edges)
        ? (raw as { edges?: Array<{ node?: unknown }> }).edges?.map((edge) => edge?.node)
        : null;
  if (!arr) return null;
  const parsed = arr
    .map((item) => toIssueStateRef(item as RestIssueResponse, baseRepo))
    .filter(Boolean) as IssueStateRef[];
  return parsed.length > 0 ? parsed : [];
}

function extractBlockedByFromRest(raw: unknown, baseRepo: string): IssueStateRef[] | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const candidates = [
    record.blocked_by,
    record.blockedBy,
    record.blocked_by_issues,
    record.blockedByIssues,
    record.dependencies,
  ];
  for (const candidate of candidates) {
    const parsed = extractIssueArray(candidate, baseRepo);
    if (parsed !== null) return parsed;
  }
  if (Array.isArray(raw)) return extractIssueArray(raw, baseRepo);
  return null;
}

function extractSubIssuesFromRest(raw: unknown, baseRepo: string): IssueStateRef[] | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const candidates = [record.sub_issues, record.subIssues, record.children];
  for (const candidate of candidates) {
    const parsed = extractIssueArray(candidate, baseRepo);
    if (parsed !== null) return parsed;
  }
  if (Array.isArray(raw)) return extractIssueArray(raw, baseRepo);
  return null;
}

function mapIssueStatesToSignals(
  issues: IssueStateRef[],
  kind: "blocked_by" | "sub_issue",
  source: "github"
): RelationshipSignal[] {
  return issues.map((issue) => ({
    source,
    kind,
    state: issue.state,
    ref: { repo: issue.repo, number: issue.number },
  }));
}

export class GitHubRelationshipProvider implements IssueRelationshipProvider {
  private github: GitHubClient;
  private depsCapability: RelationshipCapability = "unknown";
  private subIssuesCapability: RelationshipCapability = "unknown";
  private depsRestUnavailable = false;
  private subIssuesRestUnavailable = false;

  constructor(private readonly repo: string, github?: GitHubClient) {
    this.github = github ?? new GitHubClient(repo);
  }

  async getSnapshot(issue: IssueRef): Promise<IssueRelationshipSnapshot> {
    const basics = await this.fetchIssueBasics(issue);
    const signals: RelationshipSignal[] = [];
    const coverage = { githubDeps: false, githubSubIssues: false, bodyDeps: false };

    const parsed = parseIssueBodyDependencies(basics.body, issue.repo);
    signals.push(...parsed.blockedBy);
    coverage.bodyDeps = parsed.blockedBySection;

    const blockedBy = await this.fetchBlockedBy(issue);
    if (blockedBy !== null) {
      signals.push(...mapIssueStatesToSignals(blockedBy, "blocked_by", "github"));
      coverage.githubDeps = true;
    }

    const subIssues = await this.fetchSubIssues(issue);
    if (subIssues !== null) {
      signals.push(...mapIssueStatesToSignals(subIssues, "sub_issue", "github"));
      coverage.githubSubIssues = true;
    }

    return { issue, signals, coverage };
  }

  private async fetchIssueBasics(issue: IssueRef): Promise<IssueBasics> {
    const { owner, name } = splitRepoFullName(issue.repo);
    const data = await this.github.request<{ body?: string | null }>(
      `/repos/${owner}/${name}/issues/${issue.number}`
    );
    return { body: data.data?.body ?? "" };
  }

  private async fetchBlockedBy(issue: IssueRef): Promise<IssueStateRef[] | null> {
    const { owner, name } = splitRepoFullName(issue.repo);
    if (this.depsCapability === "unavailable") return null;

    if (!this.depsRestUnavailable && (this.depsCapability === "rest" || this.depsCapability === "unknown")) {
      const rest = await this.fetchRestDependencies(owner, name, issue.number, issue.repo);
      if (rest.supported) {
        this.depsCapability = "rest";
        return rest.issues;
      }
      if (rest.unavailable) {
        this.depsRestUnavailable = true;
      }
    }

    if (this.depsCapability === "graphql" || this.depsCapability === "unknown") {
      const graph = await this.fetchGraphBlockedBy(owner, name, issue.number, issue.repo);
      if (graph.supported) {
        this.depsCapability = "graphql";
        return graph.issues;
      }
      if (graph.unavailable) {
        this.depsCapability = "unavailable";
      }
    }

    return null;
  }

  private async fetchSubIssues(issue: IssueRef): Promise<IssueStateRef[] | null> {
    const { owner, name } = splitRepoFullName(issue.repo);
    if (this.subIssuesCapability === "unavailable") return null;

    if (!this.subIssuesRestUnavailable && (this.subIssuesCapability === "rest" || this.subIssuesCapability === "unknown")) {
      const rest = await this.fetchRestSubIssues(owner, name, issue.number, issue.repo);
      if (rest.supported) {
        this.subIssuesCapability = "rest";
        return rest.issues;
      }
      if (rest.unavailable) {
        this.subIssuesRestUnavailable = true;
      }
    }

    if (this.subIssuesCapability === "graphql" || this.subIssuesCapability === "unknown") {
      const graph = await this.fetchGraphSubIssues(owner, name, issue.number, issue.repo);
      if (graph.supported) {
        this.subIssuesCapability = "graphql";
        return graph.issues;
      }
      if (graph.unavailable) {
        this.subIssuesCapability = "unavailable";
      }
    }

    return null;
  }

  private async fetchRestDependencies(owner: string, repo: string, number: number, baseRepo: string) {
    try {
      const response = await this.github.request<unknown>(REST_DEPENDENCIES_PATH(owner, repo, number), {
        allowNotFound: true,
      });
      if (response.status === 404) return { supported: false, unavailable: true, issues: null };
      const parsed = extractBlockedByFromRest(response.data, baseRepo);
      if (parsed === null) return { supported: false, unavailable: false, issues: null };
      return { supported: true, unavailable: false, issues: parsed };
    } catch (error) {
      return this.handleCapabilityError(error);
    }
  }

  private async fetchRestSubIssues(owner: string, repo: string, number: number, baseRepo: string) {
    try {
      const response = await this.github.request<unknown>(REST_SUB_ISSUES_PATH(owner, repo, number), { allowNotFound: true });
      if (response.status === 404) return { supported: false, unavailable: true, issues: null };
      const parsed = extractSubIssuesFromRest(response.data, baseRepo);
      if (parsed === null) return { supported: false, unavailable: false, issues: null };
      return { supported: true, unavailable: false, issues: parsed };
    } catch (error) {
      return this.handleCapabilityError(error);
    }
  }

  private async fetchGraphBlockedBy(owner: string, repo: string, number: number, baseRepo: string) {
    return this.fetchGraphIssueConnection(GRAPH_BLOCKED_BY_QUERY, owner, repo, number, baseRepo, "blockedBy");
  }

  private async fetchGraphSubIssues(owner: string, repo: string, number: number, baseRepo: string) {
    return this.fetchGraphIssueConnection(GRAPH_SUB_ISSUES_QUERY, owner, repo, number, baseRepo, "subIssues");
  }

  private async fetchGraphIssueConnection(
    query: string,
    owner: string,
    repo: string,
    number: number,
    baseRepo: string,
    field: "blockedBy" | "subIssues"
  ) {
    try {
      const response = await this.github.request<GraphResponse>("/graphql", {
        method: "POST",
        body: { query, variables: { owner, name: repo, number } },
      });
      if (response.data?.errors?.length) {
        const messages = response.data.errors.map((err) => err?.message ?? "").join(" ");
        if (messages) return { supported: false, unavailable: true, issues: null };
      }
      const repoData = response.data?.data?.repository ?? null;
      const issue = repoData?.issue ?? null;
      const connection = issue?.[field] ?? null;
      const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
      const issues = nodes
        .map((node) => {
          const number = typeof node?.number === "number" ? node.number : null;
          if (!number) return null;
          const repoName = node?.repository?.nameWithOwner ?? baseRepo;
          if (!repoName) return null;
          return { repo: repoName, number, state: normalizeIssueState(node?.state) };
        })
        .filter(Boolean) as IssueStateRef[];
      return { supported: true, unavailable: false, issues };
    } catch (error) {
      return this.handleCapabilityError(error);
    }
  }

  private handleCapabilityError(error: unknown) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return { supported: false, unavailable: true, issues: null };
    }
    return { supported: false, unavailable: false, issues: null };
  }
}
