import type { RalphProfile } from "../config";

export type SandboxTripwireDecision = {
  allowed: boolean;
  reason: string;
  owner?: string;
  repoName?: string;
  repoFullName?: string;
};

export class SandboxTripwireError extends Error {
  readonly code = "SANDBOX_TRIPWIRE_DENY" as const;
  readonly repo: string;
  readonly owner?: string;
  readonly repoName?: string;

  constructor(params: { repo: string; owner?: string; repoName?: string; reason: string }) {
    super(`SANDBOX TRIPWIRE: refusing to mutate non-sandbox repo ${params.repo}. ${params.reason}`.trim());
    this.name = "SandboxTripwireError";
    this.repo = params.repo;
    this.owner = params.owner;
    this.repoName = params.repoName;
  }
}

function parseRepoFullName(repo: string): { owner: string; repoName: string } | null {
  const trimmed = repo.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0]!, repoName: parts[1]! };
}

export function evaluateSandboxTripwire(params: {
  profile: RalphProfile;
  repo: string;
  allowedOwners?: string[];
  repoNamePrefix?: string;
}): SandboxTripwireDecision {
  if (params.profile !== "sandbox") {
    return { allowed: true, reason: "profile is not sandbox", repoFullName: params.repo };
  }

  const parsed = parseRepoFullName(params.repo);
  if (!parsed) {
    return { allowed: false, reason: "repo is missing or invalid", repoFullName: params.repo };
  }

  const allowedOwners = (params.allowedOwners ?? []).map((o) => o.trim()).filter(Boolean);
  if (allowedOwners.length === 0) {
    return {
      allowed: false,
      reason: "sandbox.allowedOwners is missing or empty",
      owner: parsed.owner,
      repoName: parsed.repoName,
      repoFullName: params.repo,
    };
  }

  const prefix = (params.repoNamePrefix ?? "").trim();
  if (!prefix) {
    return {
      allowed: false,
      reason: "sandbox.repoNamePrefix is missing",
      owner: parsed.owner,
      repoName: parsed.repoName,
      repoFullName: params.repo,
    };
  }

  const ownerAllowed = allowedOwners.some((owner) => owner.toLowerCase() === parsed.owner.toLowerCase());
  if (!ownerAllowed) {
    return {
      allowed: false,
      reason: `owner ${parsed.owner} is not in sandbox.allowedOwners`,
      owner: parsed.owner,
      repoName: parsed.repoName,
      repoFullName: params.repo,
    };
  }

  const nameMatches = parsed.repoName.toLowerCase().startsWith(prefix.toLowerCase());
  if (!nameMatches) {
    return {
      allowed: false,
      reason: `repo name ${parsed.repoName} does not start with ${prefix}`,
      owner: parsed.owner,
      repoName: parsed.repoName,
      repoFullName: params.repo,
    };
  }

  return {
    allowed: true,
    reason: "sandbox tripwire passed",
    owner: parsed.owner,
    repoName: parsed.repoName,
    repoFullName: params.repo,
  };
}

export function assertSandboxWriteAllowed(params: {
  profile: RalphProfile;
  repo: string;
  allowedOwners?: string[];
  repoNamePrefix?: string;
}): void {
  const decision = evaluateSandboxTripwire(params);
  if (decision.allowed) return;
  throw new SandboxTripwireError({
    repo: params.repo,
    owner: decision.owner,
    repoName: decision.repoName,
    reason: decision.reason,
  });
}
