import type { ThrottleDecision } from "./throttle";

export type DaemonGate = {
  allowDequeue: boolean;
  allowResume: boolean;
  allowModelSend: boolean;
  reason: "running" | "draining" | "paused" | "hard-throttled";
};

export function computeDaemonGate(opts: {
  mode: "running" | "draining" | "paused";
  throttle: ThrottleDecision;
  isShuttingDown: boolean;
}): DaemonGate {
  if (opts.isShuttingDown) {
    return { allowDequeue: false, allowResume: false, allowModelSend: false, reason: "paused" };
  }
  if (opts.mode === "paused") {
    return { allowDequeue: false, allowResume: false, allowModelSend: false, reason: "paused" };
  }
  if (opts.throttle.state === "hard") {
    return { allowDequeue: false, allowResume: false, allowModelSend: false, reason: "hard-throttled" };
  }
  if (opts.mode === "draining") {
    return { allowDequeue: false, allowResume: true, allowModelSend: true, reason: "draining" };
  }
  if (opts.throttle.state === "soft") {
    return { allowDequeue: false, allowResume: true, allowModelSend: true, reason: "running" };
  }
  return { allowDequeue: true, allowResume: true, allowModelSend: true, reason: "running" };
}
