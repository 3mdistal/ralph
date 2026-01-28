export const SANDBOX_MARKER_TOPIC = "ralph-sandbox";
export const SANDBOX_FAILED_TOPIC = "run-failed";

export type SandboxRepoIdentity = {
  owner: string;
  name: string;
  fullName: string;
  topics?: string[];
};

export type SandboxSelectorRules = {
  allowedOwners: string[];
  repoNamePrefix: string;
};

function normalizeValue(input: string): string {
  return input.trim().toLowerCase();
}

export function isSandboxCandidate(repo: SandboxRepoIdentity, rules: SandboxSelectorRules): boolean {
  const owner = normalizeValue(repo.owner);
  const name = normalizeValue(repo.name);
  const prefix = normalizeValue(rules.repoNamePrefix);
  const allowed = (rules.allowedOwners ?? []).map(normalizeValue);
  if (!owner || !name || !prefix) return false;
  if (!allowed.includes(owner)) return false;
  return name.startsWith(prefix);
}

export function hasSandboxMarker(repo: SandboxRepoIdentity): boolean {
  const topics = repo.topics ?? [];
  return topics.map(normalizeValue).includes(SANDBOX_MARKER_TOPIC);
}

export function isSandboxMutableRepo(repo: SandboxRepoIdentity, rules: SandboxSelectorRules): boolean {
  return isSandboxCandidate(repo, rules) && hasSandboxMarker(repo);
}
