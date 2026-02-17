import type { OpencodeTransportMode } from "./transport-types";

export type TransportRunState = {
  fallbackConsumed: boolean;
};

export type TransportDecision = {
  mode: OpencodeTransportMode;
  allowFallback: boolean;
};

export function decideTransport(mode: OpencodeTransportMode, state: TransportRunState): TransportDecision {
  if (mode === "cli") return { mode: "cli", allowFallback: false };
  if (mode === "sdk") return { mode: "sdk", allowFallback: false };
  if (state.fallbackConsumed) return { mode: "cli", allowFallback: false };
  return { mode: "sdk", allowFallback: true };
}
