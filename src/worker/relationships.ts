import { formatIssueRef, type IssueRef } from "../github/issue-ref";
import { logRelationshipDiagnostics } from "../github/relationship-diagnostics";
import { resolveRelationshipSignals } from "../github/relationship-signals";
import type { RelationshipSignal } from "../github/issue-blocking-core";
import type { IssueRelationshipProvider, IssueRelationshipSnapshot } from "../github/issue-relationships";

export function createRelationshipResolver(params: {
  repo: string;
  provider: IssueRelationshipProvider;
  ttlMs: number;
  warn: (message: string) => void;
}) {
  const cache = new Map<string, { ts: number; snapshot: IssueRelationshipSnapshot }>();
  const inFlight = new Map<string, Promise<IssueRelationshipSnapshot | null>>();

  const getSnapshot = async (issue: IssueRef, allowRefresh: boolean): Promise<IssueRelationshipSnapshot | null> => {
    const key = `${issue.repo}#${issue.number}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && (!allowRefresh || now - cached.ts < params.ttlMs)) {
      return cached.snapshot;
    }

    const existing = inFlight.get(key);
    if (existing) return await existing;

    const promise = params.provider
      .getSnapshot(issue)
      .then((snapshot) => {
        cache.set(key, { ts: Date.now(), snapshot });
        return snapshot;
      })
      .catch((error) => {
        params.warn(
          `Failed to fetch relationship snapshot for ${formatIssueRef(issue)}: ${error?.message ?? String(error)}`
        );
        return null;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return await promise;
  };

  const buildSignals = (snapshot: IssueRelationshipSnapshot): RelationshipSignal[] => {
    const resolved = resolveRelationshipSignals(snapshot);
    logRelationshipDiagnostics({ repo: params.repo, issue: snapshot.issue, diagnostics: resolved.diagnostics, area: "worker" });
    return resolved.signals;
  };

  return {
    getSnapshot,
    buildSignals,
  };
}
