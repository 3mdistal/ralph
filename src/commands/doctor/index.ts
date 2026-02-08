import { buildDoctorPlan } from "./core";
import { collectDoctorState } from "./collect";
import { executeDoctorPlan } from "./execute";
import type { DoctorReport, DoctorResult } from "./types";

function toRecordDetails(record: ReturnType<typeof collectDoctorState>["records"][number]): Record<string, unknown> | undefined {
  if (record.kind === "daemon.json" || record.kind === "registry") {
    if (!record.daemon) return record.parseError ? { parseError: record.parseError } : undefined;
    return {
      daemonId: record.daemon.daemonId,
      pid: record.daemon.pid,
      startedAt: record.daemon.startedAt,
      liveness: record.daemon.liveness,
      controlFilePath: record.daemon.controlFilePath,
    };
  }
  if (record.kind === "control.json") {
    if (!record.control) return record.parseError ? { parseError: record.parseError } : undefined;
    return {
      mode: record.control.mode,
      pauseRequested: record.control.pauseRequested,
      pauseAtCheckpoint: record.control.pauseAtCheckpoint,
      drainTimeoutMs: record.control.drainTimeoutMs,
    };
  }
  return undefined;
}

function mapResultToExitCode(result: DoctorResult, hasFailures: boolean): number {
  if (result === "error") return 1;
  if (result === "collision") return 3;
  if (hasFailures) return 3;
  if (result === "needs_repair") return 2;
  return 0;
}

export function runDoctorCommand(opts?: {
  apply?: boolean;
  rootOverride?: string;
}): { report: DoctorReport; exitCode: number } {
  try {
    const collected = collectDoctorState({ rootOverride: opts?.rootOverride });
    const plan = buildDoctorPlan({ canonicalRoot: collected.canonicalRoot, records: collected.records, warnings: collected.warnings });

    let result: DoctorResult = plan.result;
    let actions = plan.actions;
    let hasFailures = false;
    if (opts?.apply && plan.result === "needs_repair") {
      const execution = executeDoctorPlan(plan.actions);
      actions = execution.actions;
      hasFailures = execution.failures > 0;
      result = hasFailures ? "collision" : "repaired";
    }

    const report: DoctorReport = {
      version: 1,
      result,
      canonicalRoot: collected.canonicalRoot,
      searchedRoots: collected.searchedRoots,
      records: collected.records.map((record) => ({
        kind: record.kind,
        path: record.path,
        status: record.status,
        details: toRecordDetails(record),
      })),
      findings: plan.findings,
      actions,
      warnings: plan.warnings,
    };

    return { report, exitCode: mapResultToExitCode(result, hasFailures) };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    const report: DoctorReport = {
      version: 1,
      result: "error",
      canonicalRoot: null,
      searchedRoots: [],
      records: [],
      findings: [{ code: "doctor-fatal", severity: "error", message }],
      actions: [],
      warnings: [],
    };
    return { report, exitCode: 1 };
  }
}
