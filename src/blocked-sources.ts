export const BLOCKED_SOURCES = [
  "deps",
  "allowlist",
  "opencode-config-invalid",
  "profile-unresolvable",
  "dirty-repo",
  "merge-target",
  "ci-only",
  "review",
  "merge-conflict",
  "stall",
  "guardrail",
  "auto-update",
  "ci-failure",
  "runtime-error",
] as const;

export type BlockedSource = (typeof BLOCKED_SOURCES)[number];
