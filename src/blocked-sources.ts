export const BLOCKED_SOURCES = [
  "deps",
  "allowlist",
  "opencode-config-invalid",
  "dirty-repo",
  "merge-target",
  "ci-only",
  "review",
  "merge-conflict",
  "permission",
  "stall",
  "loop-triage",
  "guardrail",
  "auto-update",
  "ci-failure",
  "runtime-error",
] as const;

export type BlockedSource = (typeof BLOCKED_SOURCES)[number];
