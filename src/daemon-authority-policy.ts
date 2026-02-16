import { dirname, resolve } from "path";
import {
  resolveCanonicalControlFilePath,
  resolveCanonicalControlRoot,
  resolveLegacyControlFilePathCandidates,
  resolveLegacyDaemonRegistryPathCandidates,
} from "./control-root";

export type AuthorityRootClass = "canonical" | "managed-legacy" | "unsafe-tmp" | "unknown";

export type AuthorityPolicyContext = {
  canonicalControlRoot: string;
  canonicalControlFilePath: string;
  managedLegacyRoots: Set<string>;
};

type ContextOpts = {
  homeDir?: string;
  xdgStateHome?: string;
};

function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed ? resolve(trimmed) : "";
}

function isTmpRalphRoot(root: string): boolean {
  return /^\/tmp\/ralph\/(?:[^/]+)(?:\/.*)?$/.test(root);
}

export function buildAuthorityPolicyContext(opts?: ContextOpts): AuthorityPolicyContext {
  const canonicalControlRoot = normalizePath(resolveCanonicalControlRoot({ homeDir: opts?.homeDir }));
  const canonicalControlFilePath = normalizePath(resolveCanonicalControlFilePath({ homeDir: opts?.homeDir }));

  const managedLegacyRoots = new Set<string>();
  const legacyDaemonPaths = resolveLegacyDaemonRegistryPathCandidates({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });
  const legacyControlPaths = resolveLegacyControlFilePathCandidates({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });

  for (const path of [...legacyDaemonPaths, ...legacyControlPaths]) {
    const root = normalizePath(dirname(path));
    if (!root || root === canonicalControlRoot) continue;
    if (isTmpRalphRoot(root)) continue;
    managedLegacyRoots.add(root);
  }

  return {
    canonicalControlRoot,
    canonicalControlFilePath,
    managedLegacyRoots,
  };
}

export function classifyAuthorityRoot(rootPath: string, context: AuthorityPolicyContext): AuthorityRootClass {
  const root = normalizePath(rootPath);
  if (!root) return "unknown";
  if (root === context.canonicalControlRoot) return "canonical";
  if (context.managedLegacyRoots.has(root)) return "managed-legacy";
  if (isTmpRalphRoot(root)) return "unsafe-tmp";
  return "unknown";
}

export function isTrustedAuthorityRootClass(kind: AuthorityRootClass): boolean {
  return kind === "canonical" || kind === "managed-legacy";
}

export function isTrustedControlFilePath(path: string, context: AuthorityPolicyContext): boolean {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return false;
  const rootClass = classifyAuthorityRoot(dirname(normalizedPath), context);
  return isTrustedAuthorityRootClass(rootClass);
}

export function recordMatchesCanonicalControl(
  record: { controlRoot: string; controlFilePath: string },
  context: AuthorityPolicyContext
): boolean {
  const root = normalizePath(record.controlRoot);
  const controlFilePath = normalizePath(record.controlFilePath);
  return root === context.canonicalControlRoot && controlFilePath === context.canonicalControlFilePath;
}
