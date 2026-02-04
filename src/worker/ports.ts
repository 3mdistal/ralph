import type { getThrottleDecision } from "../throttle";

export type ThrottleAdapter = {
  getThrottleDecision: typeof getThrottleDecision;
};
