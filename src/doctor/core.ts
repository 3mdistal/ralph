import { resolveCanonicalControlFilePath, resolveCanonicalControlRoot, resolveLegacyControlFilePathCandidates } from "../control-root";
import { resolveDaemonRecordPath } from "../daemon-record";
import { analyzeLiveDaemonCandidates } from "../daemon-identity-core";
import { dirname } from "path";
import {
  buildAuthorityPolicyContext,
  classifyAuthorityRoot,
  isTrustedAuthorityRootClass,
  recordMatchesCanonicalControl,
} from "../daemon-authority-policy";
import type {
  DoctorAppliedRepair,
  DoctorControlCandidate,
  DoctorDaemonCandidate,
  DoctorFinding,
  DoctorOverallStatus,
  DoctorRepairRecommendation,
  DoctorReport,
  DoctorSnapshot,
} from "./types";

function addFinding(findings: DoctorFinding[], finding: DoctorFinding): void {
  findings.push(finding);
}

function compactPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean)));
}

function sameControlShape(a: NonNullable<DoctorControlCandidate["control"]>, b: NonNullable<DoctorControlCandidate["control"]>): boolean {
  return (
    a.mode === b.mode &&
    a.pause_requested === b.pause_requested &&
    a.pause_at_checkpoint === b.pause_at_checkpoint &&
    a.drain_timeout_ms === b.drain_timeout_ms
  );
}

function computeRecommendedRepairs(input: {
  canonicalDaemonPath: string;
  staleDaemonPaths: string[];
  unreadableDaemonPaths: string[];
  liveLegacyDaemonPath: string | null;
  duplicateDaemonPaths: string[];
  controlMismatchPaths: string[];
  cleanupLegacyControlPaths: string[];
  hasLiveConflict: boolean;
}): DoctorRepairRecommendation[] {
  const repairs: DoctorRepairRecommendation[] = [];

  if (input.staleDaemonPaths.length > 0) {
    repairs.push({
      id: "quarantine-stale-daemon-records",
      code: "QUARANTINE_STALE_DAEMON_RECORDS",
      title: "Quarantine stale daemon records",
      description: "Rename stale daemon record files to .stale-<timestamp>-<pid> backups.",
      risk: "safe",
      applies_by_default: false,
      paths: compactPaths(input.staleDaemonPaths),
    });
  }

  if (input.unreadableDaemonPaths.length > 0) {
    repairs.push({
      id: "quarantine-unreadable-daemon-records",
      code: "QUARANTINE_UNREADABLE_DAEMON_RECORDS",
      title: "Quarantine unreadable daemon records",
      description: "Rename unreadable daemon record files to .corrupt-<timestamp>-<pid> backups.",
      risk: "safe",
      applies_by_default: false,
      paths: compactPaths(input.unreadableDaemonPaths),
    });
  }

  if (input.duplicateDaemonPaths.length > 0) {
    repairs.push({
      id: "quarantine-duplicate-daemon-records",
      code: "QUARANTINE_DUPLICATE_DAEMON_RECORDS",
      title: "Quarantine duplicate daemon records",
      description: "Rename duplicate live daemon record files so one canonical record remains authoritative.",
      risk: "safe",
      applies_by_default: false,
      paths: compactPaths(input.duplicateDaemonPaths),
    });
  }

  if (input.liveLegacyDaemonPath) {
    repairs.push({
      id: "promote-live-daemon-record-to-canonical",
      code: "PROMOTE_LIVE_DAEMON_RECORD_TO_CANONICAL",
      title: "Promote live daemon record to canonical path",
      description: "Copy the live legacy daemon record into the canonical registry path.",
      risk: "safe",
      applies_by_default: false,
      paths: [input.liveLegacyDaemonPath, input.canonicalDaemonPath],
    });
  }

  if (input.cleanupLegacyControlPaths.length > 0) {
    repairs.push({
      id: "cleanup-legacy-control-files",
      code: "CLEANUP_LEGACY_CONTROL_FILES",
      title: "Quarantine legacy control files",
      description: "Rename safe legacy control file duplicates that match canonical control state.",
      risk: "safe",
      applies_by_default: false,
      paths: compactPaths(input.cleanupLegacyControlPaths),
    });
  }

  if (input.controlMismatchPaths.length > 0) {
    repairs.push({
      id: "review-control-file-mismatches",
      code: "REVIEW_CONTROL_FILE_MISMATCHES",
      title: "Review control file mismatches",
      description: "Multiple readable control files disagree; choose one canonical state before applying changes.",
      risk: "needs-human",
      applies_by_default: false,
      paths: compactPaths(input.controlMismatchPaths),
    });
  }

  if (input.hasLiveConflict) {
    repairs.push({
      id: "resolve-multiple-live-daemons",
      code: "RESOLVE_MULTIPLE_LIVE_DAEMONS",
      title: "Resolve multiple live daemon records",
      description: "Multiple live daemon PIDs were detected. Stop extra daemons manually, then rerun doctor.",
      risk: "needs-human",
      applies_by_default: false,
      paths: [],
    });
  }

  return repairs;
}

export function buildDoctorReport(input: {
  snapshot: DoctorSnapshot;
  timestamp: string;
  repairMode: boolean;
  dryRun: boolean;
  appliedRepairs: DoctorAppliedRepair[];
}): DoctorReport {
  const { snapshot } = input;
  const findings: DoctorFinding[] = [];
  const daemonCandidates = snapshot.daemonCandidates;
  const controlCandidates = snapshot.controlCandidates;
  const canonicalDaemonPath = resolveDaemonRecordPath();
  const canonicalControlPath = resolveCanonicalControlFilePath();
  const legacyControlPaths = resolveLegacyControlFilePathCandidates();

  const liveDaemons = daemonCandidates.filter((candidate) => candidate.state === "live" && candidate.record);
  const staleDaemons = daemonCandidates.filter((candidate) => candidate.state === "stale");
  const unreadableDaemons = daemonCandidates.filter((candidate) => candidate.state === "unreadable");
  const canonicalDaemon = daemonCandidates.find((candidate) => candidate.is_canonical) ?? null;
  const canonicalControl = controlCandidates.find((candidate) => candidate.is_canonical) ?? null;
  const readableControls = controlCandidates.filter((candidate) => candidate.state === "readable" && candidate.control);
  const authority = buildAuthorityPolicyContext();
  const trustedLiveDaemons = liveDaemons.filter((candidate) => {
    if (!candidate.record) return false;
    const rootClass = classifyAuthorityRoot(dirname(candidate.path), authority);
    return isTrustedAuthorityRootClass(rootClass);
  });
  const liveAnalysis = analyzeLiveDaemonCandidates(
    trustedLiveDaemons.map((candidate) => ({
      path: candidate.path,
      isCanonical: candidate.is_canonical,
      alive: true,
      record: {
        daemonId: candidate.record!.daemonId,
        pid: candidate.record!.pid,
        startedAt: candidate.record!.startedAt,
        controlRoot: candidate.record!.controlRoot,
        controlFilePath: candidate.record!.controlFilePath,
      },
      candidate,
    }))
  );

  for (const candidate of liveDaemons) {
    if (!candidate.record) continue;
    const rootClass = classifyAuthorityRoot(dirname(candidate.path), authority);
    if (rootClass === "unsafe-tmp" || rootClass === "unknown") {
      addFinding(findings, {
        code: "UNSAFE_DAEMON_ROOT",
        severity: "warn",
        message: `Live daemon record at ${candidate.path} uses non-authoritative root class ${rootClass}.`,
        paths: [candidate.path],
      });
    }
  }

  if (liveAnalysis.hasConflict) {
    addFinding(findings, {
      code: "MULTIPLE_LIVE_DAEMON_RECORDS",
      severity: "error",
      message: "Multiple live daemon records were detected across known roots.",
      paths: compactPaths(trustedLiveDaemons.map((candidate) => candidate.path)),
    });
  }

  const duplicateLivePaths = compactPaths(
    liveAnalysis.duplicateGroups.flatMap((group) => group.candidates.map((candidate) => candidate.path))
  );
  if (duplicateLivePaths.length > 0) {
    addFinding(findings, {
      code: "DUPLICATE_LIVE_DAEMON_RECORDS",
      severity: "warn",
      message: "Duplicate live daemon records point to the same daemon identity across multiple roots.",
      paths: duplicateLivePaths,
    });
  }

  for (const candidate of unreadableDaemons) {
    addFinding(findings, {
      code: "UNREADABLE_DAEMON_RECORD",
      severity: "warn",
      message: `Unreadable daemon record at ${candidate.path}.`,
      paths: [candidate.path],
    });
  }

  if (staleDaemons.length > 0) {
    addFinding(findings, {
      code: "STALE_DAEMON_RECORD",
      severity: "warn",
      message: "Stale daemon records were found (PID not live).",
      paths: compactPaths(staleDaemons.map((candidate) => candidate.path)),
    });
  }

  if (!canonicalDaemon || canonicalDaemon.state === "missing") {
    addFinding(findings, {
      code: "CANONICAL_DAEMON_RECORD_MISSING",
      severity: "warn",
      message: "Canonical daemon record is missing.",
      paths: [canonicalDaemonPath],
    });
  } else if (canonicalDaemon.state === "unreadable") {
    addFinding(findings, {
      code: "CANONICAL_DAEMON_RECORD_UNREADABLE",
      severity: "warn",
      message: "Canonical daemon record exists but is unreadable.",
      paths: [canonicalDaemon.path],
    });
  }

  const liveLegacy = trustedLiveDaemons.find((candidate) => !candidate.is_canonical) ?? null;
  if (liveLegacy) {
    addFinding(findings, {
      code: "LIVE_DAEMON_RECORD_IN_LEGACY_ROOT",
      severity: "warn",
      message: "Live daemon record is in a legacy root and should be promoted to canonical path.",
      paths: [liveLegacy.path, canonicalDaemonPath],
    });
  }

  for (const candidate of liveDaemons) {
    if (candidate.identity && !candidate.identity.ok) {
      addFinding(findings, {
        code: "LIVE_DAEMON_IDENTITY_MISMATCH",
        severity: "warn",
        message: `Live daemon PID at ${candidate.path} failed identity check: ${candidate.identity.reason ?? "unknown"}`,
        paths: [candidate.path],
      });
    }
    if (candidate.record && candidate.record.controlFilePath) {
      const matchingControl = controlCandidates.find((control) => control.path === candidate.record?.controlFilePath);
      if (!matchingControl || matchingControl.state === "missing") {
        addFinding(findings, {
          code: "DAEMON_CONTROL_PATH_MISSING",
          severity: "warn",
          message: "Daemon record points to a missing control file path.",
          paths: [candidate.path, candidate.record.controlFilePath],
        });
      } else if (matchingControl.state === "unreadable") {
        addFinding(findings, {
          code: "DAEMON_CONTROL_PATH_UNREADABLE",
          severity: "warn",
          message: "Daemon record points to an unreadable control file path.",
          paths: [candidate.path, candidate.record.controlFilePath],
        });
      }
    }
  }

  for (const candidate of controlCandidates.filter((candidate) => candidate.state === "unreadable")) {
    addFinding(findings, {
      code: "UNREADABLE_CONTROL_FILE",
      severity: "warn",
      message: `Unreadable control file at ${candidate.path}.`,
      paths: [candidate.path],
    });
  }

  if (!canonicalControl || canonicalControl.state === "missing") {
    addFinding(findings, {
      code: "CANONICAL_CONTROL_FILE_MISSING",
      severity: "warn",
      message: "Canonical control file is missing.",
      paths: [canonicalControlPath],
    });
  }

  const legacyReadableControls = readableControls.filter((candidate) => legacyControlPaths.includes(candidate.path));
  if (legacyReadableControls.length > 0) {
    addFinding(findings, {
      code: "LEGACY_CONTROL_FILE_PRESENT",
      severity: "warn",
      message: "Readable legacy control file(s) detected; prefer canonical control root.",
      paths: compactPaths(legacyReadableControls.map((candidate) => candidate.path)),
    });
  }

  const mismatchPaths: string[] = [];
  if (readableControls.length > 1) {
    const base = readableControls[0]?.control;
    if (base) {
      for (const candidate of readableControls.slice(1)) {
        const control = candidate.control;
        if (!control || !sameControlShape(base, control)) mismatchPaths.push(candidate.path);
      }
      if (mismatchPaths.length > 0) mismatchPaths.push(readableControls[0]?.path ?? "");
    }
  }

  if (mismatchPaths.length > 0) {
    addFinding(findings, {
      code: "CONTROL_FILE_MISMATCH",
      severity: "warn",
      message: "Multiple readable control files disagree on control state.",
      paths: compactPaths(mismatchPaths),
    });
  }

  const liveControlRefs = new Set(
    liveDaemons.map((candidate) => candidate.record?.controlFilePath?.trim() ?? "").filter(Boolean)
  );
  const canonicalReadableControl =
    canonicalControl && canonicalControl.state === "readable" && canonicalControl.control ? canonicalControl : null;
  const cleanupLegacyControlPaths = canonicalReadableControl
    ? legacyReadableControls
        .filter((candidate) => candidate.control)
        .filter((candidate) => !liveControlRefs.has(candidate.path))
        .filter((candidate) => sameControlShape(canonicalReadableControl.control!, candidate.control!))
        .map((candidate) => candidate.path)
    : [];

  const duplicateDaemonQuarantinePaths = compactPaths(
    liveAnalysis.duplicateGroups.flatMap((group) => {
      const keepPath = group.representative.path;
      return group.candidates.filter((candidate) => candidate.path !== keepPath).map((candidate) => candidate.path);
    })
  );

  const canonicalLive = liveDaemons.some(
    (candidate) => candidate.is_canonical && !!candidate.record && recordMatchesCanonicalControl(candidate.record, authority)
  );
  const promotableLiveLegacyPath =
    !liveAnalysis.hasConflict && !canonicalLive && liveAnalysis.primaryLiveCandidate && !liveAnalysis.primaryLiveCandidate.isCanonical
      && classifyAuthorityRoot(dirname(liveAnalysis.primaryLiveCandidate.path), authority) === "managed-legacy"
      && recordMatchesCanonicalControl(liveAnalysis.primaryLiveCandidate.record, authority)
      ? liveAnalysis.primaryLiveCandidate.path
      : null;

  const unsafeCanonicalPath =
    canonicalDaemon &&
    canonicalDaemon.state === "live" &&
    canonicalDaemon.record &&
    !recordMatchesCanonicalControl(canonicalDaemon.record, authority)
      ? canonicalDaemon.path
      : null;

  const expectedRoot = resolveCanonicalControlRoot();
  for (const candidate of liveDaemons) {
    if (candidate.record && candidate.record.controlRoot !== expectedRoot) {
      addFinding(findings, {
        code: "DAEMON_CONTROL_ROOT_MISMATCH",
        severity: "warn",
        message: "Live daemon record references a non-canonical control root.",
        paths: [candidate.path],
      });
    }
  }

  const recommendations = computeRecommendedRepairs({
    canonicalDaemonPath,
    staleDaemonPaths: staleDaemons.map((candidate) => candidate.path),
    unreadableDaemonPaths: unreadableDaemons.map((candidate) => candidate.path),
    liveLegacyDaemonPath: promotableLiveLegacyPath,
    duplicateDaemonPaths: duplicateDaemonQuarantinePaths,
    controlMismatchPaths: mismatchPaths,
    cleanupLegacyControlPaths,
    hasLiveConflict: liveAnalysis.hasConflict,
  });

  if (unsafeCanonicalPath) {
    recommendations.push({
      id: "quarantine-unsafe-canonical-daemon-record",
      code: "QUARANTINE_UNSAFE_CANONICAL_DAEMON_RECORD",
      title: "Quarantine unsafe canonical daemon record",
      description: "Rename canonical daemon record when it points to unsafe/non-canonical control metadata.",
      risk: "safe",
      applies_by_default: false,
      paths: [unsafeCanonicalPath],
    });
  }

  const hasError = findings.some((finding) => finding.severity === "error");
  const hasWarn = findings.some((finding) => finding.severity === "warn");
  const overallStatus: DoctorOverallStatus = hasError ? "error" : hasWarn ? "warn" : "ok";

  return {
    schema_version: 1,
    timestamp: input.timestamp,
    overall_status: overallStatus,
    ok: overallStatus === "ok",
    repair_mode: input.repairMode,
    dry_run: input.dryRun,
    daemon_candidates: daemonCandidates,
    control_candidates: controlCandidates,
    roots: snapshot.roots,
    findings,
    recommended_repairs: recommendations,
    applied_repairs: input.appliedRepairs,
  };
}

export function resolveDoctorExitCode(report: DoctorReport): number {
  return report.overall_status === "ok" ? 0 : 1;
}
