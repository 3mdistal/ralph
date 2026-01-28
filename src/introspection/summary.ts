export const INTROSPECTION_SUMMARY_VERSION = 1;

export type IntrospectionSummary = {
  schemaVersion: number;
  sessionId: string;
  endTime: number;
  toolResultAsTextCount: number;
  totalToolCalls: number;
  stepCount: number;
  hasAnomalies: boolean;
  recentTools: string[];
};

export function isIntrospectionSummary(value: unknown): value is IntrospectionSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as IntrospectionSummary;

  return (
    typeof summary.schemaVersion === "number" &&
    typeof summary.sessionId === "string" &&
    typeof summary.endTime === "number" &&
    typeof summary.toolResultAsTextCount === "number" &&
    typeof summary.totalToolCalls === "number" &&
    typeof summary.stepCount === "number" &&
    typeof summary.hasAnomalies === "boolean" &&
    Array.isArray(summary.recentTools) &&
    summary.recentTools.every((tool) => typeof tool === "string")
  );
}
