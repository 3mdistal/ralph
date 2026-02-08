import type { DoctorReport } from "./types";

export function renderDoctorHuman(report: DoctorReport, opts?: { verbose?: boolean }): string {
  const lines: string[] = [];
  lines.push(`Result: ${report.result}`);
  lines.push(`Canonical root: ${report.canonicalRoot ?? "unknown"}`);
  lines.push(`Searched roots: ${report.searchedRoots.length}`);

  if (report.findings.length === 0) {
    lines.push("Findings: none");
  } else {
    lines.push("Findings:");
    for (const finding of report.findings) {
      const loc = finding.recordPath ? ` (${finding.recordPath})` : "";
      lines.push(`- [${finding.severity}] ${finding.code}: ${finding.message}${loc}`);
    }
  }

  if (report.actions.length === 0) {
    lines.push("Planned actions: none");
  } else {
    lines.push("Planned actions:");
    for (const action of report.actions) {
      const src = action.from ? ` from=${action.from}` : "";
      const dst = action.to ? ` to=${action.to}` : "";
      const status = action.ok === undefined ? "planned" : action.ok ? "ok" : `failed (${action.error ?? "unknown error"})`;
      lines.push(`- ${action.kind} [${action.code}]${src}${dst} -> ${status}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (opts?.verbose) {
    lines.push("Records:");
    for (const record of report.records) {
      lines.push(`- ${record.kind} ${record.status} ${record.path}`);
    }
  }

  if (report.result === "needs_repair") {
    lines.push("Run `ralphctl doctor --apply` to apply repairs.");
  }

  return lines.join("\n");
}
