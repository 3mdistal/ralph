export type IssueRef = {
  repo: string;
  number: number;
};

export function parseIssueRef(raw: string, baseRepo: string): IssueRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
  if (!match) return null;
  const repo = match[1] ? match[1] : baseRepo;
  const number = Number.parseInt(match[2], 10);
  if (!repo || !Number.isFinite(number)) return null;
  return { repo, number };
}

export function formatIssueRef(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}
