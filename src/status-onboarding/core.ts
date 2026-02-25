export type OnboardingCheckStatus = "pass" | "warn" | "fail" | "unavailable";
export type OnboardingOverallStatus = "pass" | "warn" | "fail";

export type OnboardingCheckCatalogEntry = {
  checkId: string;
  title: string;
  critical: boolean;
};

export const ONBOARDING_CHECK_CATALOG: OnboardingCheckCatalogEntry[] = [
  { checkId: "repo.access", title: "Repo access", critical: true },
  { checkId: "labels.required_set", title: "Labels present", critical: true },
  { checkId: "local.checkout_path", title: "Local checkout", critical: true },
  { checkId: "worktree.root_writable", title: "Worktree readiness", critical: true },
  { checkId: "ci.required_checks_policy", title: "CI / branch policy", critical: false },
  { checkId: "opencode.setup", title: "OpenCode setup", critical: false },
  { checkId: "github.degraded_mode", title: "GitHub degraded mode", critical: false },
];

export type OnboardingCheckCandidate = {
  checkId: string;
  status: OnboardingCheckStatus;
  reason: string;
  remediation: string[];
};

export type OnboardingCheck = OnboardingCheckCandidate & {
  title: string;
  critical: boolean;
};

export type RepoOnboardingEvaluation = {
  repo: string;
  status: OnboardingOverallStatus;
  checks: OnboardingCheck[];
};

function normalizeReason(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "No details";
}

function normalizeRemediation(items: string[]): string[] {
  return Array.from(
    new Set(
      items
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function computeOverallStatus(checks: OnboardingCheck[]): OnboardingOverallStatus {
  if (checks.some((check) => check.critical && check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn" || check.status === "unavailable" || check.status === "fail")) {
    return "warn";
  }
  return "pass";
}

export function evaluateRepoOnboarding(input: {
  repo: string;
  checks: OnboardingCheckCandidate[];
}): RepoOnboardingEvaluation {
  const byId = new Map<string, OnboardingCheckCandidate>();
  for (const check of input.checks) {
    byId.set(check.checkId, {
      checkId: check.checkId,
      status: check.status,
      reason: normalizeReason(check.reason),
      remediation: normalizeRemediation(check.remediation),
    });
  }

  const checks: OnboardingCheck[] = ONBOARDING_CHECK_CATALOG.map((entry) => {
    const candidate = byId.get(entry.checkId);
    if (candidate) {
      return {
        ...candidate,
        title: entry.title,
        critical: entry.critical,
      };
    }
    return {
      checkId: entry.checkId,
      title: entry.title,
      critical: entry.critical,
      status: "unavailable",
      reason: "Probe unavailable",
      remediation: ["Re-run `bun run status` once dependencies are available."],
    };
  });

  return {
    repo: input.repo,
    status: computeOverallStatus(checks),
    checks,
  };
}
