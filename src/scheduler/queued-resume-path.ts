export type QueuedResumePath = "merge-conflict" | "stall" | "loop-triage" | "review" | "queued-session" | "fresh";

export function classifyQueuedResumePath(params: {
  blockedSource?: string | null;
  sessionId?: string | null;
}): QueuedResumePath {
  const blockedSource = (params.blockedSource ?? "").trim();
  const sessionId = (params.sessionId ?? "").trim();

  if (!sessionId) return "fresh";
  if (blockedSource === "merge-conflict") return "merge-conflict";
  if (blockedSource === "stall") return "stall";
  if (blockedSource === "loop-triage") return "loop-triage";
  if (blockedSource === "profile-unresolvable") return "fresh";
  if (blockedSource === "review") return "review";
  return "queued-session";
}
