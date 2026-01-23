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

    // If we cannot determine the default branch (e.g. auth failure / API outage),
    // fall back to a convention-based heuristic:
    // - If we're merging to an explicit bot branch (e.g. bot/integration), treat it
    //   as a midpoint and apply ralph:in-bot.
    // - Otherwise, avoid applying the midpoint label (mislabeling a default-branch
    //   merge as "in-bot" is worse than missing it).
    const isBotBranch = normalizedBot === "bot/integration" || normalizedBot.startsWith("bot/");
    const addInBot = normalizedBase === normalizedBot && isBotBranch;
    return { addInBot, removeInProgress: true };
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
