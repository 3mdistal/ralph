import type { QueuedResumePath } from "./queued-resume-path";

export function shouldResetSessionForFreshStart(params: {
  blockedSource: string;
  sessionId: string;
  queuedResumePath: QueuedResumePath;
}): boolean {
  return (
    params.queuedResumePath === "fresh" &&
    params.blockedSource === "profile-unresolvable" &&
    params.sessionId.trim().length > 0
  );
}

export function buildFreshStartSessionResetPatch(): Record<string, string> {
  return {
    "session-id": "",
    "blocked-source": "",
    "blocked-reason": "",
    "blocked-details": "",
    "blocked-at": "",
    "blocked-checked-at": "",
  };
}
