export type ResolvedMessageTarget = {
  sessionId: string | null;
  source: "workerId" | "sessionId" | null;
};

export function resolveMessageSessionId(args: {
  workerId?: string | null;
  sessionId?: string | null;
  resolveWorkerId: (workerId: string) => string | null;
}): ResolvedMessageTarget {
  const workerId = args.workerId?.trim();
  if (workerId) {
    return {
      sessionId: args.resolveWorkerId(workerId),
      source: "workerId",
    };
  }

  const sessionId = args.sessionId?.trim();
  return {
    sessionId: sessionId || null,
    source: sessionId ? "sessionId" : null,
  };
}
