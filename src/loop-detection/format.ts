import type { LoopFileStat, LoopTripInfo } from "./core";
import { sanitizeEscalationReason } from "../github/escalation-writeback";

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${minutes}m${rem}s` : `${minutes}m`;
}

function formatFileStats(files: LoopFileStat[]): string {
  if (files.length === 0) return "- (no file touches detected)";
  return files.map((f) => `- ${f.path} (${f.touches})`).join("\n");
}

export function buildLoopTripDetails(params: {
  trip: LoopTripInfo;
  recommendedGateCommand: string;
  lastDiagnosticSnippet?: string | null;
  fallbackTouchedFiles?: string[] | null;
}): string {
  const trip = params.trip;
  const thresholds = trip.thresholds;
  const metrics = trip.metrics;

  const topFiles =
    metrics.topFiles.length > 0
      ? metrics.topFiles
      : (params.fallbackTouchedFiles ?? []).map((p) => ({ path: p, touches: 1 }));
  const snippetRaw = params.lastDiagnosticSnippet ? sanitizeEscalationReason(params.lastDiagnosticSnippet) : "";
  const snippet = snippetRaw ? truncateText(snippetRaw, 1200) : "";

  const lines: string[] = [];
  lines.push("Loop detection tripped (edit churn)");
  lines.push("");
  lines.push("Trigger:");
  lines.push(`- editsSinceGate=${metrics.editsSinceGate} (min=${thresholds.minEdits})`);
  lines.push(
    `- elapsedWithoutGate=${formatDurationMs(trip.elapsedMsWithoutGate)} (min=${formatDurationMs(thresholds.minElapsedMsWithoutGate)})`
  );
  lines.push(
    `- topFileTouches>=${thresholds.minTopFileTouches}, topFileShare>=${Math.round(thresholds.minTopFileShare * 100)}%`
  );
  lines.push("");
  lines.push("Top repeated files (bounded):");
  lines.push(formatFileStats(topFiles.slice(0, 10)));
  lines.push("");
  lines.push("Recommended next deterministic gate:");
  lines.push(`- ${params.recommendedGateCommand || "(none configured)"}`);

  if (snippet) {
    lines.push("", "Last diagnostic snippet (bounded):", snippet);
  }

  return sanitizeEscalationReason(lines.join("\n"));
}
