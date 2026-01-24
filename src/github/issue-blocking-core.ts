import { formatIssueRef, parseIssueRef, type IssueRef } from "./issue-ref";

export type RelationshipSignal = {
  source: "github" | "body";
  kind: "blocked_by" | "sub_issue";
  state: "open" | "closed" | "unknown";
  ref?: IssueRef;
};

export type BlockedDecision = {
  blocked: boolean;
  confidence: "certain" | "unknown";
  reasons: string[];
};

export type ParsedIssueBodyDependencies = {
  blockedBy: RelationshipSignal[];
  blocks: IssueRef[];
  blockedBySection: boolean;
  blocksSection: boolean;
};

const BLOCKED_BY_HEADER = /^##\s+blocked by\s*$/i;
const BLOCKS_HEADER = /^##\s+blocks\s*$/i;

export function parseIssueBodyDependencies(body: string, baseRepo: string): ParsedIssueBodyDependencies {
  const lines = body.split(/\r?\n/);
  let section: "blocked_by" | "blocks" | null = null;

  const blockedBy: RelationshipSignal[] = [];
  const blocks: IssueRef[] = [];
  let blockedBySection = false;
  let blocksSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (BLOCKED_BY_HEADER.test(line)) {
      section = "blocked_by";
      blockedBySection = true;
      continue;
    }
    if (BLOCKS_HEADER.test(line)) {
      section = "blocks";
      blocksSection = true;
      continue;
    }
    if (line.startsWith("## ")) {
      section = null;
      continue;
    }
    if (!section) continue;

    const match = line.match(/^(?:[-*]\s+)?\[(?<checked>[ xX])\]\s+(?<rest>.+)$/);
    if (!match?.groups?.rest) continue;

    const rest = match.groups.rest.trim();
    const refMatch = rest.match(/^(?<ref>(?:[\w.-]+\/[\w.-]+)?#\d+)/);
    if (!refMatch?.groups?.ref) continue;

    const ref = parseIssueRef(refMatch.groups.ref, baseRepo);
    if (!ref) continue;

    if (section === "blocked_by") {
      blockedBy.push({
        source: "body",
        kind: "blocked_by",
        state: match.groups.checked.toLowerCase() === "x" ? "closed" : "open",
        ref,
      });
    } else {
      blocks.push(ref);
    }
  }

  return { blockedBy, blocks, blockedBySection, blocksSection };
}

export function computeBlockedDecision(signals: RelationshipSignal[]): BlockedDecision {
  const blockers = signals.filter((signal) => signal.kind === "blocked_by" || signal.kind === "sub_issue");
  const hasOpen = blockers.some((signal) => signal.state === "open");
  const hasUnknown = blockers.some((signal) => signal.state === "unknown");

  if (hasOpen) {
    const reasons = blockers
      .filter((signal) => signal.state === "open")
      .map((signal) => {
        const ref = signal.ref ? formatIssueRef(signal.ref) : "unknown issue";
        return signal.kind === "sub_issue" ? `open sub-issue ${ref}` : `blocked by ${ref}`;
      });
    return { blocked: true, confidence: "certain", reasons };
  }

  if (hasUnknown) {
    return { blocked: false, confidence: "unknown", reasons: ["relationship coverage unknown"] };
  }

  return { blocked: false, confidence: "certain", reasons: [] };
}
