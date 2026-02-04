import { getRepoBotBranch, getRepoRequiredChecksOverride } from "../config";
import { GitHubApiError, type GitHubClient, splitRepoFullName } from "../github/client";
import {
  getProtectionContexts,
  resolveRequiredChecks,
  type BranchProtection,
  type ResolvedRequiredChecks,
} from "../github/required-checks";
import { formatDuration } from "../logging";
import {
  REQUIRED_CHECKS_DEFER_LOG_INTERVAL_MS,
  REQUIRED_CHECKS_DEFER_RETRY_MS,
  areStringArraysEqual,
  decideBranchProtection,
  formatRequiredChecksGuidance,
  hasBypassAllowances,
  normalizeEnabledFlag,
  normalizeRestrictions,
  toSortedUniqueStrings,
  type CheckRunsResponse,
  type CommitStatusResponse,
  type GitRef,
  type RepoDetails,
} from "./lanes/required-checks";

export function createBranchProtectionManager(params: {
  repo: string;
  github: GitHubClient;
  shouldLogBackoff: (key: string, intervalMs: number) => boolean;
}) {
  const repo = params.repo;
  const github = params.github;

  let ensureBranchProtectionPromise: Promise<void> | null = null;
  let ensureBranchProtectionDeferUntil = 0;
  let requiredChecksForMergePromise: Promise<ResolvedRequiredChecks> | null = null;

  const githubApiRequest = async <T>(
    path: string,
    opts: { method?: string; body?: unknown; allowNotFound?: boolean } = {}
  ): Promise<T | null> => {
    const response = await github.request<T>(path, opts);
    return response.data;
  };

  const isNoCommitFoundError = (error: unknown): boolean => {
    if (!(error instanceof GitHubApiError)) return false;
    if (error.status !== 422) return false;
    return /No commit found for SHA/i.test(error.responseText);
  };

  const isRefAlreadyExistsError = (error: unknown): boolean => {
    if (!(error instanceof GitHubApiError)) return false;
    if (error.status !== 422) return false;
    return /Reference already exists/i.test(error.responseText);
  };

  const buildMissingBranchError = (error: GitHubApiError): Error => {
    const message = error.message || error.responseText || "Missing branch";
    const missingBranchError = new Error(message);
    missingBranchError.cause = "missing-branch";
    return missingBranchError;
  };

  const fetchCheckRunNames = async (branch: string): Promise<string[]> => {
    const { owner, name } = splitRepoFullName(repo);
    const encodedBranch = encodeURIComponent(branch);
    try {
      const payload = await githubApiRequest<CheckRunsResponse>(
        `/repos/${owner}/${name}/commits/${encodedBranch}/check-runs?per_page=100`
      );
      return toSortedUniqueStrings(payload?.check_runs?.map((run) => run?.name ?? "") ?? []);
    } catch (e: any) {
      if (isNoCommitFoundError(e)) {
        throw buildMissingBranchError(e);
      }
      throw e;
    }
  };

  const fetchStatusContextNames = async (branch: string): Promise<string[]> => {
    const { owner, name } = splitRepoFullName(repo);
    const encodedBranch = encodeURIComponent(branch);
    try {
      const payload = await githubApiRequest<CommitStatusResponse>(
        `/repos/${owner}/${name}/commits/${encodedBranch}/status?per_page=100`
      );
      return toSortedUniqueStrings(payload?.statuses?.map((status) => status?.context ?? "") ?? []);
    } catch (e: any) {
      if (isNoCommitFoundError(e)) {
        throw buildMissingBranchError(e);
      }
      throw e;
    }
  };

  const fetchAvailableCheckContexts = async (branch: string): Promise<string[]> => {
    const errors: string[] = [];
    let missingBranchError: Error | null = null;
    let checkRuns: string[] = [];
    let statusContexts: string[] = [];

    try {
      checkRuns = await fetchCheckRunNames(branch);
    } catch (e: any) {
      if (e?.cause === "missing-branch") {
        missingBranchError = e;
      } else {
        errors.push(`check-runs: ${e?.message ?? String(e)}`);
      }
    }

    try {
      statusContexts = await fetchStatusContextNames(branch);
    } catch (e: any) {
      if (e?.cause === "missing-branch") {
        missingBranchError = e;
      } else {
        errors.push(`status: ${e?.message ?? String(e)}`);
      }
    }

    if (missingBranchError) throw missingBranchError;

    const hasData = checkRuns.length > 0 || statusContexts.length > 0;
    const hasAuthError = errors.some((entry) => /HTTP 401|HTTP 403|Missing GH_TOKEN/i.test(entry));

    if (hasAuthError || (errors.length >= 2 && !hasData)) {
      throw new Error(`Unable to read check contexts for ${branch}: ${errors.join(" | ")}`);
    }

    if (errors.length > 0) {
      console.warn(`[ralph:worker:${repo}] Failed to fetch some check contexts for ${branch}: ${errors.join(" | ")}`);
    }

    return toSortedUniqueStrings([...checkRuns, ...statusContexts]);
  };

  const fetchRepoDefaultBranch = async (): Promise<string | null> => {
    const { owner, name } = splitRepoFullName(repo);
    const payload = await githubApiRequest<RepoDetails>(`/repos/${owner}/${name}`);
    const branch = payload?.default_branch ?? null;
    return branch ? String(branch) : null;
  };

  const fetchGitRef = async (ref: string): Promise<GitRef | null> => {
    const { owner, name } = splitRepoFullName(repo);
    return githubApiRequest<GitRef>(`/repos/${owner}/${name}/git/ref/${ref}`, { allowNotFound: true });
  };

  const createGitRef = async (ref: string, sha: string): Promise<void> => {
    const { owner, name } = splitRepoFullName(repo);
    await githubApiRequest(`/repos/${owner}/${name}/git/refs`, {
      method: "POST",
      body: { ref: `refs/${ref}`, sha },
    });
  };

  const ensureRemoteBranchExists = async (branch: string): Promise<boolean> => {
    const ref = `heads/${branch}`;
    const existing = await fetchGitRef(ref);
    if (existing?.object?.sha) return false;

    const defaultBranch = await fetchRepoDefaultBranch();
    if (!defaultBranch) {
      throw new Error(`Unable to resolve default branch for ${repo}; cannot create ${branch}.`);
    }

    const defaultRef = await fetchGitRef(`heads/${defaultBranch}`);
    const defaultSha = defaultRef?.object?.sha ? String(defaultRef.object.sha) : null;
    if (!defaultSha) {
      throw new Error(`Unable to resolve ${repo}@${defaultBranch} sha; cannot create ${branch}.`);
    }

    try {
      await createGitRef(ref, defaultSha);
      console.log(`[ralph:worker:${repo}] Created missing branch ${branch} from ${defaultBranch} (${defaultSha}).`);
      return true;
    } catch (e: any) {
      if (isRefAlreadyExistsError(e)) return false;
      throw e;
    }
  };

  const fetchBranchProtection = async (branch: string): Promise<BranchProtection | null> => {
    const { owner, name } = splitRepoFullName(repo);
    return githubApiRequest<BranchProtection>(
      `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`,
      { allowNotFound: true }
    );
  };

  const resolveFallbackBranch = async (botBranch: string): Promise<string> => {
    try {
      const defaultBranch = await fetchRepoDefaultBranch();
      if (defaultBranch && defaultBranch !== botBranch) return defaultBranch;
    } catch {
      // ignore; fallback handled below
    }

    return "main";
  };

  const resolveRequiredChecksForMerge = async (): Promise<ResolvedRequiredChecks> => {
    if (requiredChecksForMergePromise) return requiredChecksForMergePromise;

    requiredChecksForMergePromise = (async () => {
      const override = getRepoRequiredChecksOverride(repo);
      if (override !== null) {
        return { checks: override, source: "config" };
      }

      const botBranch = getRepoBotBranch(repo);
      const fallbackBranch = await resolveFallbackBranch(botBranch);
      return resolveRequiredChecks({
        override,
        primaryBranch: botBranch,
        fallbackBranch,
        fetchBranchProtection: (branch) => fetchBranchProtection(branch),
        logger: {
          warn: (message) => console.warn(`[ralph:worker:${repo}] ${message}`),
          info: (message) => console.log(`[ralph:worker:${repo}] ${message}`),
        },
      });
    })();

    return requiredChecksForMergePromise;
  };

  const ensureBranchProtectionForBranch = async (
    branch: string,
    requiredChecks: string[]
  ): Promise<"ok" | "defer"> => {
    if (requiredChecks.length === 0) return "ok";

    const botBranch = getRepoBotBranch(repo);
    if (branch === botBranch) {
      await ensureRemoteBranchExists(branch);
    }

    let availableChecks: string[] = [];
    try {
      availableChecks = await fetchAvailableCheckContexts(branch);
    } catch (e: any) {
      if (branch === botBranch && e?.cause === "missing-branch") {
        await ensureRemoteBranchExists(branch);
        availableChecks = await fetchAvailableCheckContexts(branch);
      } else {
        throw e;
      }
    }

    const decision = decideBranchProtection({ requiredChecks, availableChecks });
    if (decision.kind !== "ok") {
      const guidance = formatRequiredChecksGuidance({
        repo,
        branch,
        requiredChecks,
        missingChecks: decision.missingChecks,
        availableChecks,
      });
      if (decision.kind === "defer") {
        const logKey = `branch-protection-defer:${repo}:${branch}:${decision.missingChecks.join(",") || "none"}::${availableChecks.join(",") || "none"}`;
        if (params.shouldLogBackoff(logKey, REQUIRED_CHECKS_DEFER_LOG_INTERVAL_MS)) {
          console.warn(
            `[ralph:worker:${repo}] RALPH_BRANCH_PROTECTION_SKIPPED_MISSING_CHECKS ` +
              `Required checks missing for ${repo}@${branch} ` +
              `(required: ${requiredChecks.join(", ") || "(none)"}; ` +
              `missing: ${decision.missingChecks.join(", ") || "(none)"}). ` +
              `Proceeding without branch protection for now; will retry in ${formatDuration(
                REQUIRED_CHECKS_DEFER_RETRY_MS
              )}.\n${guidance}`
          );
        }
        return "defer";
      }

      throw new Error(
        `Required checks missing for ${repo}@${branch}. ` +
          `The configured required check contexts are not present.\n${guidance}`
      );
    }

    const existing = await fetchBranchProtection(branch);
    const contexts = toSortedUniqueStrings([...getProtectionContexts(existing), ...requiredChecks]);
    const strict = existing?.required_status_checks?.strict === true;
    const reviews = existing?.required_pull_request_reviews;

    const desiredReviews = {
      dismissal_restrictions: normalizeRestrictions(reviews?.dismissal_restrictions),
      dismiss_stale_reviews: reviews?.dismiss_stale_reviews ?? false,
      require_code_owner_reviews: reviews?.require_code_owner_reviews ?? false,
      required_approving_review_count: 0,
      require_last_push_approval: reviews?.require_last_push_approval ?? false,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    };

    const desiredPayload = {
      required_status_checks: { strict, contexts },
      enforce_admins: true,
      required_pull_request_reviews: desiredReviews,
      restrictions: normalizeRestrictions(existing?.restrictions),
      required_linear_history: normalizeEnabledFlag(existing?.required_linear_history),
      allow_force_pushes: normalizeEnabledFlag(existing?.allow_force_pushes),
      allow_deletions: normalizeEnabledFlag(existing?.allow_deletions),
      block_creations: normalizeEnabledFlag(existing?.block_creations),
      required_conversation_resolution: normalizeEnabledFlag(existing?.required_conversation_resolution),
      required_signatures: normalizeEnabledFlag(existing?.required_signatures),
      lock_branch: normalizeEnabledFlag(existing?.lock_branch),
      allow_fork_syncing: normalizeEnabledFlag(existing?.allow_fork_syncing),
    };

    const existingContexts = getProtectionContexts(existing);
    const needsStatusUpdate = !existing || !areStringArraysEqual(existingContexts, contexts);
    const existingApprovals = reviews?.required_approving_review_count ?? null;
    const needsReviewUpdate =
      !reviews || existingApprovals !== 0 || hasBypassAllowances(reviews?.bypass_pull_request_allowances);
    const needsAdminUpdate = !normalizeEnabledFlag(existing?.enforce_admins);

    if (!existing || needsStatusUpdate || needsReviewUpdate || needsAdminUpdate) {
      const { owner, name } = splitRepoFullName(repo);
      await githubApiRequest(
        `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`,
        { method: "PUT", body: desiredPayload }
      );
      console.log(
        `[ralph:worker:${repo}] Ensured branch protection for ${branch} (required checks: ${requiredChecks.join(", ")})`
      );
    }

    return "ok";
  };

  const ensureBranchProtectionOnce = async (): Promise<void> => {
    if (ensureBranchProtectionPromise) return ensureBranchProtectionPromise;

    const now = Date.now();
    if (now < ensureBranchProtectionDeferUntil) return;

    ensureBranchProtectionPromise = (async () => {
      const botBranch = getRepoBotBranch(repo);
      const requiredChecksOverride = getRepoRequiredChecksOverride(repo);

      if (requiredChecksOverride === null || requiredChecksOverride.length === 0) {
        return;
      }

      const fallbackBranch = await resolveFallbackBranch(botBranch);
      const branches = Array.from(new Set([botBranch, fallbackBranch]));

      let deferred = false;

      for (const branch of branches) {
        const result = await ensureBranchProtectionForBranch(branch, requiredChecksOverride);
        if (result === "defer") deferred = true;
      }

      return deferred;
    })().then((deferred) => {
      if (deferred) {
        ensureBranchProtectionDeferUntil = Date.now() + REQUIRED_CHECKS_DEFER_RETRY_MS;
        ensureBranchProtectionPromise = null;
      }
    });

    return ensureBranchProtectionPromise;
  };

  return {
    fetchAvailableCheckContexts,
    fetchRepoDefaultBranch,
    fetchGitRef,
    resolveRequiredChecksForMerge,
    ensureBranchProtectionForBranch,
    ensureBranchProtectionOnce,
  };
}
