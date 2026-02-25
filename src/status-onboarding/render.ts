import type { RepoOnboardingEvaluation } from "./core";

function statusBadge(status: "pass" | "warn" | "fail" | "unavailable"): string {
  if (status === "pass") return "PASS";
  if (status === "warn") return "WARN";
  if (status === "fail") return "FAIL";
  return "UNAVAILABLE";
}

function overallBadge(status: "pass" | "warn" | "fail"): string {
  return status.toUpperCase();
}

export function formatOnboardingSection(repos: RepoOnboardingEvaluation[]): string[] {
  const lines: string[] = ["Onboarding:"];
  if (repos.length === 0) {
    lines.push("  - no managed repos configured");
    return lines;
  }

  for (const repo of repos) {
    lines.push(`  - ${repo.repo}: ${overallBadge(repo.status)}`);
    for (const check of repo.checks) {
      const remediation = check.remediation[0] ? ` hint=${check.remediation[0]}` : "";
      lines.push(`      [${statusBadge(check.status)}] ${check.title} — ${check.reason}${remediation}`);
    }
  }
  return lines;
}
