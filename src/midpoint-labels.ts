export type MidpointLabelPlan = {
  addInBot: boolean;
  removeInProgress: boolean;
};

export function normalizeGitRef(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, "");
}

export function computeMidpointLabelPlan(input: {
  baseBranch: string;
  botBranch: string;
  defaultBranch: string;
}): MidpointLabelPlan {
  const normalizedBase = normalizeGitRef(input.baseBranch);
  const normalizedBot = normalizeGitRef(input.botBranch);
  const normalizedDefault = normalizeGitRef(input.defaultBranch);
  const shouldSkipInBot = normalizedBase === normalizedDefault || normalizedBot === normalizedDefault;
  if (shouldSkipInBot) {
    return { addInBot: false, removeInProgress: true };
  }
  if (normalizedBase !== normalizedBot) {
    return { addInBot: false, removeInProgress: false };
  }
  return { addInBot: true, removeInProgress: true };
}
