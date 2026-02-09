import type { DoctorReport } from "./types";

function summarizeCounts(report: DoctorReport): string {
  const live = report.daemon_candidates.filter((candidate) => candidate.state === "live").length;
  const stale = report.daemon_candidates.filter((candidate) => candidate.state === "stale").length;
  const unreadableDaemon = report.daemon_candidates.filter((candidate) => candidate.state === "unreadable").length;
  const unreadableControl = report.control_candidates.filter((candidate) => candidate.state === "unreadable").length;
  return `daemon(live=${live}, stale=${stale}, unreadable=${unreadableDaemon}), control(unreadable=${unreadableControl})`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Doctor status: ${report.overall_status}`);
  lines.push(`Checked roots: ${report.roots.length}`);
  lines.push(`Findings: ${report.findings.length}`);
  lines.push(`Summary: ${summarizeCounts(report)}`);

  if (report.findings.length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const finding of report.findings) {
      const suffix = finding.paths.length > 0 ? ` [${finding.paths.join(", ")}]` : "";
      lines.push(`- (${finding.severity}) ${finding.code}: ${finding.message}${suffix}`);
    }
  }

  if (report.recommended_repairs.length > 0) {
    lines.push("");
    lines.push("Recommended actions:");
    for (const recommendation of report.recommended_repairs) {
      lines.push(`- ${recommendation.id} (${recommendation.risk}): ${recommendation.title}`);
    }
    if (!report.repair_mode) {
      lines.push("Run `ralphctl doctor --repair` to apply safe repairs.");
    }
  }

  if (report.applied_repairs.length > 0) {
    lines.push("");
    lines.push("Applied actions:");
    for (const action of report.applied_repairs) {
      lines.push(`- ${action.id}: ${action.status} - ${action.details}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
