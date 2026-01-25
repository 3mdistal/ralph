import { getIdempotencyPayload, initStateDb, upsertIdempotencyKey } from "./state";

export type WatchdogSignatureRecord = {
  signatureHash: string;
  retryIndex: number;
  sessionId?: string;
  stuckCommentUrl?: string | null;
  updatedAt?: string;
};

const KEY_PREFIX = "watchdog-signature";

export function buildWatchdogSignatureKey(params: { repo: string; issueNumber: number; stage: string }): string {
  return `${KEY_PREFIX}:${params.repo}#${params.issueNumber}:${params.stage}`;
}

export function getWatchdogSignatureRecord(params: {
  repo: string;
  issueNumber: number;
  stage: string;
}): WatchdogSignatureRecord | null {
  initStateDb();
  const payload = getIdempotencyPayload(buildWatchdogSignatureKey(params));
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as WatchdogSignatureRecord;
    if (!parsed || typeof parsed.signatureHash !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function upsertWatchdogSignatureRecord(params: {
  repo: string;
  issueNumber: number;
  stage: string;
  record: WatchdogSignatureRecord;
}): void {
  initStateDb();
  const payload = JSON.stringify(params.record);
  upsertIdempotencyKey({
    key: buildWatchdogSignatureKey(params),
    scope: KEY_PREFIX,
    payloadJson: payload,
  });
}
