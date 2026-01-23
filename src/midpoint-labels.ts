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
  if (!input.baseBranch.trim()) {
    return { addInBot: false, removeInProgress: true };
  }
  if (!input.defaultBranch.trim()) {
    const normalizedBase = normalizeGitRef(input.baseBranch);
    const normalizedBot = normalizeGitRef(input.botBranch);

    // If we cannot determine the default branch (e.g. auth failure / API outage), be
    // conservative: only apply the midpoint label when it's clearly a non-default
    // bot branch. Mislabeling a direct-to-main merge as "in-bot" is worse than
    // missing the midpoint label.
    const botLooksLikeDefault = normalizedBot === "main" || normalizedBot === "master";
    return { addInBot: normalizedBase === normalizedBot && !botLooksLikeDefault, removeInProgress: true };
  }
  const normalizedBase = normalizeGitRef(input.baseBranch);
  const normalizedBot = normalizeGitRef(input.botBranch);
  const normalizedDefault = normalizeGitRef(input.defaultBranch);
  const shouldSkipInBot = normalizedBase === normalizedDefault || normalizedBot === normalizedDefault;
  if (shouldSkipInBot) {
    return { addInBot: false, removeInProgress: true };
  }
  if (normalizedBase !== normalizedBot) {
    return { addInBot: false, removeInProgress: true };
  }
  return { addInBot: true, removeInProgress: true };
}
