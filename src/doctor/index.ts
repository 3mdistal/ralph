import { applyDoctorRepairs } from "./repair";
import { buildDoctorReport, resolveDoctorExitCode } from "./core";
import { collectDoctorSnapshot } from "./io";
import { formatDoctorReport } from "./render";
import type { DoctorReport } from "./types";

export type RunDoctorOptions = {
  repair: boolean;
  dryRun: boolean;
  now?: Date;
};

export type RunDoctorResult = {
  report: DoctorReport;
  text: string;
  exitCode: number;
};

export function runDoctor(input: RunDoctorOptions): RunDoctorResult {
  const now = input.now ?? new Date();
  const snapshot = collectDoctorSnapshot();
  const baseline = buildDoctorReport({
    snapshot,
    timestamp: now.toISOString(),
    repairMode: input.repair,
    dryRun: input.dryRun,
    appliedRepairs: [],
  });

  const appliedRepairs = input.repair
    ? applyDoctorRepairs({
        snapshot,
        recommendations: baseline.recommended_repairs.filter((item) => item.risk === "safe"),
        dryRun: input.dryRun,
        nowIso: now.toISOString(),
      })
    : [];

  const report = buildDoctorReport({
    snapshot: collectDoctorSnapshot(),
    timestamp: now.toISOString(),
    repairMode: input.repair,
    dryRun: input.dryRun,
    appliedRepairs,
  });

  return {
    report,
    text: formatDoctorReport(report),
    exitCode: resolveDoctorExitCode(report),
  };
}
