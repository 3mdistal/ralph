import { existsSync, readFileSync, renameSync } from "fs";
import { basename } from "path";
import { writeDaemonRecord } from "../daemon-record";
import type { DoctorAppliedRepair, DoctorRepairRecommendation, DoctorSnapshot } from "./types";

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildSuffix(kind: "stale" | "corrupt", nowIso: string): string {
  const compact = nowIso.replace(/[-:.TZ]/g, "");
  return `.${kind}-${compact}-${process.pid}`;
}

function renameWithSuffix(path: string, suffix: string): string {
  const target = `${path}${suffix}`;
  renameSync(path, target);
  return target;
}

function loadRecordFromFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

export function applyDoctorRepairs(input: {
  snapshot: DoctorSnapshot;
  recommendations: DoctorRepairRecommendation[];
  dryRun: boolean;
  nowIso: string;
}): DoctorAppliedRepair[] {
  const byId = new Map(input.recommendations.map((item) => [item.id, item]));
  const applied: DoctorAppliedRepair[] = [];

  const staleRepair = byId.get("quarantine-stale-daemon-records");
  if (staleRepair) {
    const staleCandidates = input.snapshot.daemonCandidates.filter((candidate) => candidate.state === "stale" && candidate.record);
    for (const candidate of staleCandidates) {
      if (!candidate.record) continue;
      if (isPidAlive(candidate.record.pid)) {
        applied.push({
          id: staleRepair.id,
          code: staleRepair.code,
          status: "skipped",
          details: `Skipped ${candidate.path}: pid ${candidate.record.pid} became live during repair pass.`,
          paths: [candidate.path],
        });
        continue;
      }
      if (input.dryRun) {
        applied.push({
          id: staleRepair.id,
          code: staleRepair.code,
          status: "skipped",
          details: `Dry run: would rename ${candidate.path}.`,
          paths: [candidate.path],
        });
        continue;
      }
      try {
        const renamed = renameWithSuffix(candidate.path, buildSuffix("stale", input.nowIso));
        applied.push({
          id: staleRepair.id,
          code: staleRepair.code,
          status: "applied",
          details: `Renamed ${basename(candidate.path)} -> ${basename(renamed)}.`,
          paths: [candidate.path, renamed],
        });
      } catch (error: any) {
        applied.push({
          id: staleRepair.id,
          code: staleRepair.code,
          status: "failed",
          details: `Failed to quarantine ${candidate.path}: ${error?.message ?? String(error)}`,
          paths: [candidate.path],
        });
      }
    }
  }

  const unreadableRepair = byId.get("quarantine-unreadable-daemon-records");
  if (unreadableRepair) {
    const unreadableCandidates = input.snapshot.daemonCandidates.filter((candidate) => candidate.state === "unreadable" && candidate.exists);
    for (const candidate of unreadableCandidates) {
      if (input.dryRun) {
        applied.push({
          id: unreadableRepair.id,
          code: unreadableRepair.code,
          status: "skipped",
          details: `Dry run: would rename ${candidate.path}.`,
          paths: [candidate.path],
        });
        continue;
      }
      try {
        if (!existsSync(candidate.path)) {
          applied.push({
            id: unreadableRepair.id,
            code: unreadableRepair.code,
            status: "skipped",
            details: `Skipped ${candidate.path}: file no longer exists.`,
            paths: [candidate.path],
          });
          continue;
        }
        const renamed = renameWithSuffix(candidate.path, buildSuffix("corrupt", input.nowIso));
        applied.push({
          id: unreadableRepair.id,
          code: unreadableRepair.code,
          status: "applied",
          details: `Renamed ${basename(candidate.path)} -> ${basename(renamed)}.`,
          paths: [candidate.path, renamed],
        });
      } catch (error: any) {
        applied.push({
          id: unreadableRepair.id,
          code: unreadableRepair.code,
          status: "failed",
          details: `Failed to quarantine ${candidate.path}: ${error?.message ?? String(error)}`,
          paths: [candidate.path],
        });
      }
    }
  }

  const promoteRepair = byId.get("promote-live-daemon-record-to-canonical");
  if (promoteRepair) {
    const candidate = input.snapshot.daemonCandidates.find((entry) => entry.state === "live" && !entry.is_canonical && entry.record) ?? null;
    if (!candidate || !candidate.record) {
      applied.push({
        id: promoteRepair.id,
        code: promoteRepair.code,
        status: "skipped",
        details: "Skipped promotion: no live legacy daemon record candidate available.",
        paths: promoteRepair.paths,
      });
    } else if (input.snapshot.daemonCandidates.filter((entry) => entry.state === "live").length > 1) {
      applied.push({
        id: promoteRepair.id,
        code: promoteRepair.code,
        status: "skipped",
        details: "Skipped promotion: multiple live daemon records detected; requires manual resolution.",
        paths: promoteRepair.paths,
      });
    } else if (input.dryRun) {
      applied.push({
        id: promoteRepair.id,
        code: promoteRepair.code,
        status: "skipped",
        details: `Dry run: would write canonical daemon record from ${candidate.path}.`,
        paths: promoteRepair.paths,
      });
    } else {
      try {
        if (!isPidAlive(candidate.record.pid)) {
          applied.push({
            id: promoteRepair.id,
            code: promoteRepair.code,
            status: "skipped",
            details: `Skipped promotion: pid ${candidate.record.pid} is no longer live.`,
            paths: promoteRepair.paths,
          });
        } else {
          const parsed = loadRecordFromFile(candidate.path) as Record<string, unknown>;
          const normalizedCommand = Array.isArray(parsed.command)
            ? parsed.command.filter((token): token is string => typeof token === "string")
            : candidate.record.command;
          writeDaemonRecord(
            {
              version: 1,
              daemonId: candidate.record.daemonId,
              pid: candidate.record.pid,
              startedAt: candidate.record.startedAt,
              heartbeatAt: candidate.record.heartbeatAt,
              controlRoot: candidate.record.controlRoot,
              ralphVersion: candidate.record.ralphVersion,
              command: normalizedCommand,
              cwd: candidate.record.cwd,
              controlFilePath: candidate.record.controlFilePath,
            },
            { writeLegacy: false }
          );
          applied.push({
            id: promoteRepair.id,
            code: promoteRepair.code,
            status: "applied",
            details: `Wrote canonical daemon record from live legacy source ${candidate.path}.`,
            paths: promoteRepair.paths,
          });
        }
      } catch (error: any) {
        applied.push({
          id: promoteRepair.id,
          code: promoteRepair.code,
          status: "failed",
          details: `Failed to promote live daemon record: ${error?.message ?? String(error)}`,
          paths: promoteRepair.paths,
        });
      }
    }
  }

  return applied;
}
