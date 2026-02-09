export type DoctorOverallStatus = "ok" | "warn" | "error";

export type DoctorFindingSeverity = "warn" | "error";

export type DoctorRepairRisk = "safe" | "needs-human";

export type DoctorRepairResultStatus = "applied" | "skipped" | "failed";

export type DoctorDaemonCandidateState = "missing" | "live" | "stale" | "unreadable";

export type DoctorControlCandidateState = "missing" | "readable" | "unreadable";

export type DoctorFinding = {
  code: string;
  severity: DoctorFindingSeverity;
  message: string;
  paths: string[];
};

export type DoctorRepairRecommendation = {
  id: string;
  code: string;
  title: string;
  description: string;
  risk: DoctorRepairRisk;
  applies_by_default: false;
  paths: string[];
};

export type DoctorAppliedRepair = {
  id: string;
  code: string;
  status: DoctorRepairResultStatus;
  details: string;
  paths: string[];
};

export type DoctorIdentityCheck = {
  ok: boolean;
  reason: string | null;
};

export type DoctorDaemonRecordView = {
  daemonId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  controlRoot: string;
  controlFilePath: string;
  cwd: string;
  command: string[];
  ralphVersion: string | null;
};

export type DoctorDaemonCandidate = {
  path: string;
  root: string;
  is_canonical: boolean;
  exists: boolean;
  state: DoctorDaemonCandidateState;
  parse_error: string | null;
  record: DoctorDaemonRecordView | null;
  pid_alive: boolean | null;
  identity: DoctorIdentityCheck | null;
};

export type DoctorControlStateView = {
  mode: "running" | "draining" | "paused";
  pause_requested: boolean | null;
  pause_at_checkpoint: string | null;
  drain_timeout_ms: number | null;
};

export type DoctorControlCandidate = {
  path: string;
  root: string;
  is_canonical: boolean;
  exists: boolean;
  state: DoctorControlCandidateState;
  parse_error: string | null;
  control: DoctorControlStateView | null;
};

export type DoctorRootSummary = {
  root: string;
  daemon_record_paths: string[];
  daemon_records_present: number;
  control_file_paths: string[];
  control_files_present: number;
};

export type DoctorSnapshot = {
  daemonCandidates: DoctorDaemonCandidate[];
  controlCandidates: DoctorControlCandidate[];
  roots: DoctorRootSummary[];
};

export type DoctorReport = {
  schema_version: 1;
  timestamp: string;
  overall_status: DoctorOverallStatus;
  ok: boolean;
  repair_mode: boolean;
  dry_run: boolean;
  daemon_candidates: DoctorDaemonCandidate[];
  control_candidates: DoctorControlCandidate[];
  roots: DoctorRootSummary[];
  findings: DoctorFinding[];
  recommended_repairs: DoctorRepairRecommendation[];
  applied_repairs: DoctorAppliedRepair[];
};
