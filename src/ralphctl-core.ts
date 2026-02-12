import type { StatusSnapshot } from "./status-snapshot";

function isDurableStateWritable(snapshot: StatusSnapshot): boolean {
  const durableState = snapshot.durableState;
  if (!durableState) return true;
  if (typeof durableState.canWriteState === "boolean") return durableState.canWriteState;
  if (durableState.ok === false) return false;
  return durableState.verdict !== "readable_readonly_forward_newer";
}

export function isSnapshotDrained(snapshot: StatusSnapshot): boolean {
  return snapshot.starting.length === 0 && snapshot.inProgress.length === 0;
}

export function shouldUseGraceDrainFallback(snapshot: StatusSnapshot): boolean {
  return !isDurableStateWritable(snapshot);
}

export function getResumptionVerificationSkipReason(before: StatusSnapshot, after: StatusSnapshot): string | null {
  if (!isDurableStateWritable(before)) {
    return "durable state is degraded before restart";
  }
  if (!isDurableStateWritable(after)) {
    return "durable state is degraded after restart";
  }
  return null;
}
