import type { DaemonRecord } from "./daemon-record";

export type DaemonPidState = "alive" | "dead" | "unknown";
export type DaemonLivenessState = "alive" | "missing" | "dead" | "unknown";

export type DaemonLivenessSnapshot = {
  state: DaemonLivenessState;
  mismatch: boolean;
  hint: string | null;
  pid: number | null;
  daemonId: string | null;
};

const LIVENESS_HINT = "Daemon liveness mismatch; restart the daemon or repair stale daemon state.";

function probePidState(pid: number): DaemonPidState {
  if (!Number.isFinite(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error: any) {
    if (error && typeof error === "object" && error.code === "EPERM") return "unknown";
    return "dead";
  }
}

export function deriveDaemonLiveness(params: {
  desiredMode: string;
  daemonRecord: Pick<DaemonRecord, "daemonId" | "pid"> | null;
  probe?: (pid: number) => DaemonPidState;
}): {
  desiredMode: string;
  effectiveMode: string;
  daemonLiveness: DaemonLivenessSnapshot;
} {
  const probe = params.probe ?? probePidState;
  const daemonRecord = params.daemonRecord;

  let state: DaemonLivenessState = "missing";
  let pid: number | null = null;
  let daemonId: string | null = null;

  if (daemonRecord) {
    daemonId = daemonRecord.daemonId ?? null;
    pid = typeof daemonRecord.pid === "number" ? daemonRecord.pid : null;
    if (pid === null) {
      state = "unknown";
    } else {
      const pidState = probe(pid);
      state = pidState === "alive" ? "alive" : pidState;
    }
  }

  const mismatch = params.desiredMode === "running" && state !== "alive";
  const effectiveMode = mismatch ? "stale" : params.desiredMode;

  return {
    desiredMode: params.desiredMode,
    effectiveMode,
    daemonLiveness: {
      state,
      mismatch,
      hint: mismatch ? LIVENESS_HINT : null,
      pid,
      daemonId,
    },
  };
}

export function formatDaemonLivenessLine(liveness: DaemonLivenessSnapshot): string | null {
  if (liveness.state === "alive" && !liveness.mismatch) return null;
  const parts = [`state=${liveness.state}`];
  if (liveness.mismatch) parts.push("mismatch=true");
  if (typeof liveness.pid === "number") parts.push(`pid=${liveness.pid}`);
  const status = parts.join(" ");
  const hint = liveness.hint ? ` hint=${liveness.hint}` : "";
  return `Daemon liveness: ${status}${hint}`;
}
