import type { BlockedSource } from "../blocked-sources";

export type QueueTaskStatus =
  | "queued"
  | "starting"
  | "in-progress"
  | "throttled"
  | "blocked"
  | "escalated"
  | "done";

export interface QueueTask {
  _path: string;
  _name: string;
  type: "agent-task";
  "creation-date": string;
  scope: string;
  issue: string;
  repo: string;
  status: QueueTaskStatus;
  priority?: string;
  name: string;
  run?: string;
  "assigned-at"?: string;
  "completed-at"?: string;
  /** Hard throttle metadata (best-effort) */
  "throttled-at"?: string;
  "resume-at"?: string;
  "usage-snapshot"?: string;
  /** OpenCode session ID used to resume after restarts */
  "session-id"?: string;
  /** Daemon identifier owning this task (for rolling restart safety). */
  "daemon-id"?: string;
  /** Last heartbeat timestamp from owning daemon. */
  "heartbeat-at"?: string;
  /** OpenCode profile name used for this task (persisted for resume). */
  "opencode-profile"?: string;
  /** Path to restart-survivable OpenCode run output log */
  "run-log-path"?: string;
  /** Git worktree path for this task (for per-repo concurrency + resume) */
  "worktree-path"?: string;
  /** Stable worker identity (repo#taskId). */
  "worker-id"?: string;
  /** Per-repo concurrency slot (0..max-1). */
  "repo-slot"?: string;
  /** Watchdog recovery attempts (string in frontmatter) */
  "watchdog-retries"?: string;
  /** Blocked reason category */
  "blocked-source"?: BlockedSource;
  /** Short explanation of block reason */
  "blocked-reason"?: string;
  /** Last time blocking was checked */
  "blocked-checked-at"?: string;
  /** Last checkpoint reached by worker */
  checkpoint?: string;
  /** Pause requested at next checkpoint */
  "pause-requested"?: string;
}

export type AgentTask = QueueTask;

export type QueueChangeHandler = (tasks: QueueTask[]) => void;
