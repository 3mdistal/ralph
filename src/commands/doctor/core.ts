import { join } from "path";
import type { DoctorAction, DoctorFinding, DoctorObservedRecord, DoctorPlan } from "./types";

function sortByStartedAtDesc(records: DoctorObservedRecord[]): DoctorObservedRecord[] {
  return [...records].sort((a, b) => {
    const aTs = Date.parse(a.daemon?.startedAt ?? "");
    const bTs = Date.parse(b.daemon?.startedAt ?? "");
    if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
    if (Number.isFinite(aTs)) return -1;
    if (Number.isFinite(bTs)) return 1;
    return 0;
  });
}

function makeQuarantinePath(path: string, now: number): string {
  return `${path}.quarantine-${now}`;
}

function asFinding(code: string, severity: DoctorFinding["severity"], message: string, recordPath?: string): DoctorFinding {
  return { code, severity, message, recordPath };
}

export function buildDoctorPlan(input: {
  canonicalRoot: string;
  records: DoctorObservedRecord[];
  warnings: string[];
  now?: number;
}): DoctorPlan {
  const now = input.now ?? Date.now();
  const findings: DoctorFinding[] = [];
  const actions: DoctorAction[] = [];

  const daemonRecords = input.records.filter((record) => record.kind === "daemon.json");
  const controlRecords = input.records.filter((record) => record.kind === "control.json");

  for (const record of daemonRecords) {
    if (record.status === "invalid") {
      findings.push(asFinding("invalid-daemon-record", "warning", "Invalid daemon record detected", record.path));
      if (record.exists) {
        actions.push({
          kind: "quarantine",
          code: "quarantine-invalid-daemon-record",
          from: record.path,
          to: makeQuarantinePath(record.path, now),
          preconditions: { mtimeMs: record.mtimeMs, size: record.size },
        });
      }
    }
    if (record.status === "unreadable") {
      findings.push(asFinding("unreadable-daemon-record", "warning", "Unreadable daemon record detected", record.path));
    }
  }

  for (const record of controlRecords) {
    if (record.status === "invalid") {
      findings.push(asFinding("invalid-control-record", "warning", "Invalid control record detected", record.path));
      if (record.exists) {
        actions.push({
          kind: "quarantine",
          code: "quarantine-invalid-control-record",
          from: record.path,
          to: makeQuarantinePath(record.path, now),
          preconditions: { mtimeMs: record.mtimeMs, size: record.size },
        });
      }
    }
    if (record.status === "unreadable") {
      findings.push(asFinding("unreadable-control-record", "warning", "Unreadable control record detected", record.path));
    }
  }

  const parsedDaemons = daemonRecords.filter((record) => record.daemon);
  const aliveDaemons = sortByStartedAtDesc(parsedDaemons.filter((record) => record.daemon?.liveness === "alive"));
  const unknownDaemons = parsedDaemons.filter((record) => record.daemon?.liveness === "unknown");

  if (unknownDaemons.length > 0) {
    for (const record of unknownDaemons) {
      findings.push(
        asFinding(
          "pid-liveness-unknown",
          "warning",
          `PID liveness is unknown for daemon pid=${record.daemon?.pid}; skipping destructive repair decisions`,
          record.path
        )
      );
    }
  }

  if (aliveDaemons.length > 1) {
    const ids = aliveDaemons
      .map((record) => `${record.daemon?.daemonId ?? "unknown"}@${record.daemon?.pid ?? "unknown"}`)
      .join(", ");
    findings.push(asFinding("multiple-live-daemons", "error", `Multiple live daemon records detected: ${ids}`));
    return { result: "collision", findings, actions: [], warnings: input.warnings };
  }

  const canonicalDaemonPath = join(input.canonicalRoot, "daemon.json");
  const canonicalDaemon = daemonRecords.find((record) => record.path === canonicalDaemonPath) ?? null;
  const live = aliveDaemons[0] ?? null;

  if (live && live.path !== canonicalDaemonPath) {
    findings.push(
      asFinding(
        "live-daemon-outside-canonical-root",
        "warning",
        `Live daemon record is outside canonical root: ${live.path}`,
        live.path
      )
    );
    if (live.payloadText) {
      actions.push({ kind: "write", code: "write-canonical-daemon-record", to: canonicalDaemonPath, payloadText: live.payloadText });
    }
  }

  for (const record of parsedDaemons) {
    if (record.daemon?.liveness === "dead") {
      findings.push(asFinding("stale-daemon-record", "warning", "Stale daemon record points to dead PID", record.path));
      actions.push({
        kind: "quarantine",
        code: "quarantine-stale-daemon-record",
        from: record.path,
        to: makeQuarantinePath(record.path, now),
        preconditions: { mtimeMs: record.mtimeMs, size: record.size },
      });
    }
  }

  if (live) {
    const expectedControlPath = join(live.root, "control.json");
    if (live.daemon?.controlFilePath && live.daemon.controlFilePath !== expectedControlPath) {
      findings.push(
        asFinding(
          "control-path-mismatch",
          "warning",
          `Live daemon control path mismatches root control record: ${live.daemon.controlFilePath}`,
          live.path
        )
      );
    }
  }

  if (!live && parsedDaemons.length === 0) {
    findings.push(asFinding("no-daemon-records", "info", "No daemon records found in searched roots"));
  }

  const uniqueActions = new Map<string, DoctorAction>();
  for (const action of actions) {
    const key = `${action.kind}:${action.from ?? ""}:${action.to ?? ""}:${action.code}`;
    if (!uniqueActions.has(key)) uniqueActions.set(key, action);
  }

  const plannedActions = [...uniqueActions.values()].filter((action) => {
    if (action.code.startsWith("quarantine") && unknownDaemons.some((record) => record.path === action.from)) {
      return false;
    }
    return true;
  });

  if (plannedActions.length === 0 && findings.every((finding) => finding.severity !== "error")) {
    return { result: "healthy", findings, actions: [], warnings: input.warnings };
  }

  return { result: "needs_repair", findings, actions: plannedActions, warnings: input.warnings };
}
