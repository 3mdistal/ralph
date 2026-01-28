import type {
  StatusBlockedTask,
  StatusDrainSnapshot,
  StatusInProgressTask,
  StatusQueueSnapshot,
  StatusSnapshot,
  StatusTaskBase,
  StatusThrottledTask,
} from "../status-snapshot";
import type { StatusUsageSnapshot } from "../status-usage";

export type ControlPlaneStateV1 = {
  mode: string;
  queue: StatusQueueSnapshot;
  controlProfile: string | null;
  activeProfile: string | null;
  throttle: unknown;
  usage?: StatusUsageSnapshot;
  escalations: { pending: number };
  inProgress: StatusInProgressTask[];
  starting: StatusTaskBase[];
  queued: StatusTaskBase[];
  throttled: StatusThrottledTask[];
  blocked: StatusBlockedTask[];
  drain: StatusDrainSnapshot;
};

export function toControlPlaneStateV1(snapshot: StatusSnapshot): ControlPlaneStateV1 {
  return snapshot;
}
