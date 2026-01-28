export const BLOCKED_SOURCES = [
  "deps",
  "allowlist",
  "dirty-repo",
  "merge-target",
  "ci-only",
  "merge-conflict",
  "stall",
  "auto-update",
  "ci-failure",
  "runtime-error",
] as const;

export type BlockedSource = (typeof BLOCKED_SOURCES)[number];
