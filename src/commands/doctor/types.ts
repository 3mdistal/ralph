export type DoctorRecordKind = "registry" | "daemon.json" | "control.json";

export type DoctorRecordStatus = "live" | "stale" | "unreadable" | "missing" | "invalid";

export type DoctorResult = "healthy" | "needs_repair" | "repaired" | "collision" | "error";

export type DoctorLiveness = "alive" | "dead" | "unknown";

export type DoctorSeverity = "info" | "warning" | "error";

export type DoctorObservedRecord = {
  kind: DoctorRecordKind;
  path: string;
  root: string;
  exists: boolean;
  isReadable: boolean;
  status: DoctorRecordStatus;
  parseError?: string;
  payloadText?: string;
  mtimeMs?: number;
  size?: number;
  daemon?: {
    daemonId: string;
    pid: number;
    startedAt: string;
    ralphVersion: string | null;
    command: string[];
    cwd: string;
    controlFilePath: string;
    liveness: DoctorLiveness;
  };
  control?: {
    mode: "running" | "draining" | "paused";
    pauseRequested?: boolean;
    pauseAtCheckpoint?: string;
    drainTimeoutMs?: number;
  };
};

export type DoctorFinding = {
  code: string;
  severity: DoctorSeverity;
  message: string;
  recordPath?: string;
};

export type DoctorActionKind = "write" | "copy" | "move" | "quarantine";

export type DoctorAction = {
  kind: DoctorActionKind;
  code: string;
  from?: string;
  to?: string;
  payloadText?: string;
  preconditions?: {
    mtimeMs?: number;
    size?: number;
  };
  ok?: boolean;
  error?: string;
};

export type DoctorPlan = {
  result: Exclude<DoctorResult, "repaired" | "error">;
  findings: DoctorFinding[];
  actions: DoctorAction[];
  warnings: string[];
};

export type DoctorReport = {
  version: 1;
  result: DoctorResult;
  canonicalRoot: string | null;
  searchedRoots: string[];
  records: Array<{
    kind: DoctorRecordKind;
    path: string;
    status: DoctorRecordStatus;
    details?: Record<string, unknown>;
  }>;
  findings: DoctorFinding[];
  actions: DoctorAction[];
  warnings: string[];
};
