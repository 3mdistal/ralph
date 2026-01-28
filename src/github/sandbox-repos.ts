import { GitHubClient, splitRepoFullName } from "./client";

export type SandboxRepoRecord = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  createdAt: string;
  archived: boolean;
  topics: string[];
};

type OwnerProfile = "User" | "Organization" | "Unknown";

type UserProfileResponse = {
  type?: string | null;
};

type RepoListItem = {
  id?: number;
  name?: string | null;
  full_name?: string | null;
  owner?: { login?: string | null } | null;
  created_at?: string | null;
  archived?: boolean | null;
};

type RepoTopicsResponse = {
  names?: string[] | null;
};

async function fetchOwnerProfile(github: GitHubClient, owner: string): Promise<OwnerProfile> {
  const response = await github.request<UserProfileResponse>(`/users/${owner}`);
  const raw = response.data?.type ?? null;
  if (raw === "Organization") return "Organization";
  if (raw === "User") return "User";
  return "Unknown";
}

function buildRepoListPath(owner: string, ownerType: OwnerProfile, page: number): string {
  const base = ownerType === "Organization" ? `/orgs/${owner}/repos` : `/users/${owner}/repos`;
  const params = new URLSearchParams({
    per_page: "100",
    page: String(page),
    sort: "created",
    direction: "desc",
  });
  if (ownerType === "Organization") params.set("type", "all");
  return `${base}?${params.toString()}`;
}

function normalizeRepoRecord(item: RepoListItem): SandboxRepoRecord | null {
  const id = typeof item.id === "number" ? item.id : null;
  const name = typeof item.name === "string" ? item.name : null;
  const fullName = typeof item.full_name === "string" ? item.full_name : null;
  const owner = typeof item.owner?.login === "string" ? item.owner?.login : null;
  const createdAt = typeof item.created_at === "string" ? item.created_at : null;
  const archived = Boolean(item.archived);
  if (!id || !name || !fullName || !owner || !createdAt) return null;
  return { id, name, fullName, owner, createdAt, archived, topics: [] };
}

export async function listOwnerRepos(params: {
  github: GitHubClient;
  owner: string;
}): Promise<SandboxRepoRecord[]> {
  const ownerType = await fetchOwnerProfile(params.github, params.owner);
  const results: SandboxRepoRecord[] = [];

  for (let page = 1; page <= 20; page += 1) {
    const path = buildRepoListPath(params.owner, ownerType, page);
    const response = await params.github.request<RepoListItem[]>(path);
    const items = response.data ?? [];
    const normalized = items.map(normalizeRepoRecord).filter(Boolean) as SandboxRepoRecord[];
    results.push(...normalized);
    if (items.length < 100) break;
  }

  return results;
}

export async function fetchRepoTopics(params: {
  github: GitHubClient;
  repoFullName: string;
}): Promise<string[]> {
  const { owner, name } = splitRepoFullName(params.repoFullName);
  const response = await params.github.request<RepoTopicsResponse>(`/repos/${owner}/${name}/topics`);
  const topics = response.data?.names ?? [];
  return topics.map((topic) => String(topic ?? "").trim()).filter(Boolean);
}

export async function ensureRepoTopics(params: {
  github: GitHubClient;
  repoFullName: string;
  topics: string[];
}): Promise<{ applied: string[]; unchanged: boolean }>
{
  const current = await fetchRepoTopics({ github: params.github, repoFullName: params.repoFullName });
  const next = Array.from(new Set([...current, ...params.topics].map((topic) => topic.trim()).filter(Boolean)));
  const unchanged = current.length === next.length && current.every((topic) => next.includes(topic));
  if (unchanged) return { applied: current, unchanged: true };
  const { owner, name } = splitRepoFullName(params.repoFullName);
  await params.github.request(`/repos/${owner}/${name}/topics`, {
    method: "PUT",
    body: { names: next },
  });
  return { applied: next, unchanged: false };
}

export async function archiveRepo(params: { github: GitHubClient; repoFullName: string }): Promise<void> {
  const { owner, name } = splitRepoFullName(params.repoFullName);
  await params.github.request(`/repos/${owner}/${name}`, {
    method: "PATCH",
    body: { archived: true },
  });
}

export async function deleteRepo(params: { github: GitHubClient; repoFullName: string }): Promise<void> {
  const { owner, name } = splitRepoFullName(params.repoFullName);
  await params.github.request(`/repos/${owner}/${name}`, { method: "DELETE" });
}
