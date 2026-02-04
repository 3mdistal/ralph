export type BranchProtection = {
  required_status_checks?: {
    strict?: boolean | null;
    contexts?: string[] | null;
    checks?: Array<{ context?: string | null }> | null;
  } | null;
  enforce_admins?: { enabled?: boolean | null } | boolean | null;
  required_pull_request_reviews?: {
    dismissal_restrictions?: {
      users?: Array<{ login?: string | null }> | null;
      teams?: Array<{ slug?: string | null }> | null;
      apps?: Array<{ slug?: string | null }> | null;
    } | null;
    dismiss_stale_reviews?: boolean | null;
    require_code_owner_reviews?: boolean | null;
    required_approving_review_count?: number | null;
    require_last_push_approval?: boolean | null;
    bypass_pull_request_allowances?: {
      users?: Array<{ login?: string | null }> | null;
      teams?: Array<{ slug?: string | null }> | null;
      apps?: Array<{ slug?: string | null }> | null;
    } | null;
  } | null;
  restrictions?: {
    users?: Array<{ login?: string | null }> | null;
    teams?: Array<{ slug?: string | null }> | null;
    apps?: Array<{ slug?: string | null }> | null;
  } | null;
  required_linear_history?: { enabled?: boolean | null } | boolean | null;
  allow_force_pushes?: { enabled?: boolean | null } | boolean | null;
  allow_deletions?: { enabled?: boolean | null } | boolean | null;
  block_creations?: { enabled?: boolean | null } | boolean | null;
  required_conversation_resolution?: { enabled?: boolean | null } | boolean | null;
  required_signatures?: { enabled?: boolean | null } | boolean | null;
  lock_branch?: { enabled?: boolean | null } | boolean | null;
  allow_fork_syncing?: { enabled?: boolean | null } | boolean | null;
};

export type ResolvedRequiredChecks = {
  checks: string[];
  source: "config" | "protection" | "none";
  branch?: string;
};

function toSortedUniqueStrings(values: Array<string | null | undefined>): string[] {
  const normalized = values.map((value) => (value ?? "").trim()).filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}

export function getProtectionContexts(protection: BranchProtection | null): string[] {
  const contexts = protection?.required_status_checks?.contexts ?? [];
  const checks = protection?.required_status_checks?.checks ?? [];
  const checkContexts = checks.map((check) => check?.context ?? "");
  return toSortedUniqueStrings([...contexts, ...checkContexts]);
}

type RequiredChecksLogger = {
  warn?: (message: string) => void;
  info?: (message: string) => void;
};

type RequiredChecksResolverParams = {
  override: string[] | null;
  primaryBranch: string;
  fallbackBranch?: string | null;
  fetchBranchProtection: (branch: string) => Promise<BranchProtection | null>;
  logger?: RequiredChecksLogger;
};

export async function resolveRequiredChecks(params: RequiredChecksResolverParams): Promise<ResolvedRequiredChecks> {
  if (params.override !== null) {
    return { checks: params.override, source: "config" };
  }

  const protectionErrors: Array<{ branch: string; error: unknown }> = [];
  const logWarn = params.logger?.warn ?? ((message: string) => console.warn(message));
  const logInfo = params.logger?.info ?? ((message: string) => console.log(message));

  const tryFetchProtection = async (branch: string): Promise<BranchProtection | null> => {
    try {
      return await params.fetchBranchProtection(branch);
    } catch (error) {
      protectionErrors.push({ branch, error });
      return null;
    }
  };

  const primaryProtection = await tryFetchProtection(params.primaryBranch);
  if (primaryProtection) {
    return {
      checks: getProtectionContexts(primaryProtection),
      source: "protection",
      branch: params.primaryBranch,
    };
  }

  const fallbackBranch = params.fallbackBranch ?? params.primaryBranch;
  if (fallbackBranch && fallbackBranch !== params.primaryBranch) {
    const fallbackProtection = await tryFetchProtection(fallbackBranch);
    if (fallbackProtection) {
      return {
        checks: getProtectionContexts(fallbackProtection),
        source: "protection",
        branch: fallbackBranch,
      };
    }
  }

  if (protectionErrors.length > 0) {
    for (const entry of protectionErrors) {
      const msg = (entry.error as any)?.message ?? String(entry.error);
      logWarn(`Unable to read branch protection for ${entry.branch}: ${msg}`);
    }
  } else {
    const attempted = Array.from(new Set([params.primaryBranch, fallbackBranch].filter(Boolean))).join(", ");
    logInfo(`No branch protection found for ${attempted}; merge gating disabled.`);
  }

  return { checks: [], source: "none" };
}
