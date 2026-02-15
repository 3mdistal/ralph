import { relative, resolve } from "path";

import { isPathUnderDir } from "./git-worktree";

export type ManagedWorktreePathClassification = {
  kind: "slot-root" | "legacy-root" | "parent" | "invalid" | "outside-managed-root";
  normalizedPath: string;
  segments: string[];
};

function splitManagedSegments(path: string, managedRoot: string): string[] {
  const rel = relative(resolve(managedRoot), resolve(path));
  if (!rel || rel.startsWith("..")) return [];
  return rel.split(/[\\/]+/).filter(Boolean);
}

function isNumericIssueSegment(value: string | undefined): boolean {
  return Boolean(value && /^\d+$/.test(value));
}

export function classifyManagedWorktreePath(path: string, managedRoot: string): ManagedWorktreePathClassification {
  const normalizedPath = resolve(path);
  if (!isPathUnderDir(normalizedPath, managedRoot)) {
    return {
      kind: "outside-managed-root",
      normalizedPath,
      segments: [],
    };
  }

  const segments = splitManagedSegments(normalizedPath, managedRoot);
  if (segments.length < 2) {
    return { kind: "invalid", normalizedPath, segments };
  }

  const issueSegmentIndex = segments[1]?.startsWith("slot-") ? 2 : 1;
  const issueSegment = segments[issueSegmentIndex];

  if (!isNumericIssueSegment(issueSegment)) {
    return { kind: "invalid", normalizedPath, segments };
  }

  if (segments[1]?.startsWith("slot-")) {
    if (!/^slot-\d+$/.test(segments[1])) {
      return { kind: "invalid", normalizedPath, segments };
    }
    if (segments.length === 3) {
      return { kind: "parent", normalizedPath, segments };
    }
    if (segments.length === 4) {
      return { kind: "slot-root", normalizedPath, segments };
    }
    return { kind: "invalid", normalizedPath, segments };
  }

  if (segments.length === 2) {
    return { kind: "parent", normalizedPath, segments };
  }
  if (segments.length === 3) {
    return { kind: "legacy-root", normalizedPath, segments };
  }

  return { kind: "invalid", normalizedPath, segments };
}

export function isManagedWorktreeRootClassification(classification: ManagedWorktreePathClassification): boolean {
  return classification.kind === "slot-root" || classification.kind === "legacy-root";
}
