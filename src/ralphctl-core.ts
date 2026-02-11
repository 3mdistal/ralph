import type { StatusSnapshot } from "./status-snapshot";

export function isSnapshotDrained(snapshot: StatusSnapshot): boolean {
  return snapshot.starting.length === 0 && snapshot.inProgress.length === 0;
}

export function shouldUseGraceDrainFallback(snapshot: StatusSnapshot): boolean {
  return snapshot.durableState?.ok === false;
}

export function getResumptionVerificationSkipReason(before: StatusSnapshot, after: StatusSnapshot): string | null {
  if (before.durableState?.ok === false) {
    return "durable state is degraded before restart";
  }
  if (after.durableState?.ok === false) {
    return "durable state is degraded after restart";
  }
  return null;
}
