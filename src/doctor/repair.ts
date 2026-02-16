import { existsSync, readFileSync, renameSync } from "fs";
import { basename, dirname } from "path";
import {
  readDaemonRecordAtPath,
  resolveDaemonRecordPath,
  resolveDaemonRecordPathCandidates,
  writeDaemonRecord,
} from "../daemon-record";
import { analyzeLiveDaemonCandidates, buildDaemonIdentityKey } from "../daemon-identity-core";
import { buildAuthorityPolicyContext, classifyAuthorityRoot, recordMatchesCanonicalControl } from "../daemon-authority-policy";
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

function buildSuffix(kind: "stale" | "corrupt" | "duplicate" | "legacy", nowIso: string): string {
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

function sameRecordShape(a: {
  daemonId: string;
  pid: number;
  controlRoot: string;
  controlFilePath: string;
  cwd: string;
  command: string[];
}, b: {
  daemonId: string;
  pid: number;
  controlRoot: string;
  controlFilePath: string;
  cwd: string;
  command: string[];
}): boolean {
  return (
    a.daemonId === b.daemonId &&
    a.pid === b.pid &&
    a.controlRoot === b.controlRoot &&
    a.controlFilePath === b.controlFilePath &&
    a.cwd === b.cwd &&
    a.command.length === b.command.length &&
    a.command.every((token, index) => token === b.command[index])
  );
}

type ControlShape = {
  mode: "running" | "draining" | "paused";
  pauseRequested: boolean | null;
  pauseAtCheckpoint: string | null;
  drainTimeoutMs: number | null;
};

function parseControlShape(path: string): ControlShape | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const versionRaw = parsed.version;
    const version = versionRaw === undefined ? 0 : versionRaw;
    if (version !== 0 && version !== 1) return null;
    const mode = parsed.mode;
    if (mode !== "running" && mode !== "draining" && mode !== "paused") return null;
    const pauseRequested = typeof parsed.pause_requested === "boolean" ? parsed.pause_requested : null;
    const pauseAtCheckpoint =
      typeof parsed.pause_at_checkpoint === "string" && parsed.pause_at_checkpoint.trim()
        ? parsed.pause_at_checkpoint.trim()
        : null;
    const drainTimeoutMs =
      typeof parsed.drain_timeout_ms === "number" && Number.isFinite(parsed.drain_timeout_ms)
        ? Math.max(0, Math.floor(parsed.drain_timeout_ms))
        : null;
    return {
      mode,
      pauseRequested,
      pauseAtCheckpoint,
      drainTimeoutMs,
    };
  } catch {
    return null;
  }
}

function sameControlShape(a: ControlShape, b: ControlShape): boolean {
  return (
    a.mode === b.mode &&
    a.pauseRequested === b.pauseRequested &&
    a.pauseAtCheckpoint === b.pauseAtCheckpoint &&
    a.drainTimeoutMs === b.drainTimeoutMs
  );
}

function collectCurrentLiveIdentityCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of resolveDaemonRecordPathCandidates()) {
    const record = readDaemonRecordAtPath(path);
    if (!record || !isPidAlive(record.pid)) continue;
    const key = buildDaemonIdentityKey(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countDistinctCurrentLiveIdentities(): number {
  return collectCurrentLiveIdentityCounts().size;
}

function hasLiveDaemonReferencingControl(path: string): boolean {
  for (const daemonPath of resolveDaemonRecordPathCandidates()) {
    const record = readDaemonRecordAtPath(daemonPath);
    if (!record || !isPidAlive(record.pid)) continue;
    if (record.controlFilePath.trim() === path) return true;
  }
  return false;
}

export function applyDoctorRepairs(input: {
  snapshot: DoctorSnapshot;
  recommendations: DoctorRepairRecommendation[];
  dryRun: boolean;
  nowIso: string;
}): DoctorAppliedRepair[] {
  const byId = new Map(input.recommendations.map((item) => [item.id, item]));
  const applied: DoctorAppliedRepair[] = [];
  const authority = buildAuthorityPolicyContext();

  const liveAnalysis = analyzeLiveDaemonCandidates(
    input.snapshot.daemonCandidates
      .filter((candidate) => candidate.state === "live" && candidate.record)
      .map((candidate) => ({
        path: candidate.path,
        isCanonical: candidate.is_canonical,
        alive: true,
        record: {
          daemonId: candidate.record!.daemonId,
          pid: candidate.record!.pid,
          startedAt: candidate.record!.startedAt,
        },
      }))
  );
  const preferredByIdentity = new Map(liveAnalysis.groups.map((group) => [group.key, group.representative.path]));

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

  const duplicateRepair = byId.get("quarantine-duplicate-daemon-records");
  if (duplicateRepair) {
    for (const path of duplicateRepair.paths) {
      if (path === resolveDaemonRecordPath()) {
        applied.push({
          id: duplicateRepair.id,
          code: duplicateRepair.code,
          status: "skipped",
          details: `Skipped ${path}: canonical daemon record is kept as authoritative.`,
          paths: [path],
        });
        continue;
      }

      if (input.dryRun) {
        applied.push({
          id: duplicateRepair.id,
          code: duplicateRepair.code,
          status: "skipped",
          details: `Dry run: would rename ${path}.`,
          paths: [path],
        });
        continue;
      }

      try {
        const record = readDaemonRecordAtPath(path);
        if (!record) {
          applied.push({
            id: duplicateRepair.id,
            code: duplicateRepair.code,
            status: "skipped",
            details: `Skipped ${path}: daemon record is unreadable or missing.`,
            paths: [path],
          });
          continue;
        }
        if (!isPidAlive(record.pid)) {
          applied.push({
            id: duplicateRepair.id,
            code: duplicateRepair.code,
            status: "skipped",
            details: `Skipped ${path}: pid ${record.pid} is no longer live.`,
            paths: [path],
          });
          continue;
        }

        const identityKey = buildDaemonIdentityKey(record);
        const preferredPath = preferredByIdentity.get(identityKey) ?? null;
        if (preferredPath === path) {
          applied.push({
            id: duplicateRepair.id,
            code: duplicateRepair.code,
            status: "skipped",
            details: `Skipped ${path}: selected as preferred record for identity ${identityKey}.`,
            paths: [path],
          });
          continue;
        }

        const currentCounts = collectCurrentLiveIdentityCounts();
        if ((currentCounts.get(identityKey) ?? 0) <= 1) {
          applied.push({
            id: duplicateRepair.id,
            code: duplicateRepair.code,
            status: "skipped",
            details: `Skipped ${path}: identity ${identityKey} is no longer duplicated.`,
            paths: [path],
          });
          continue;
        }

        if (!existsSync(path)) {
          applied.push({
            id: duplicateRepair.id,
            code: duplicateRepair.code,
            status: "skipped",
            details: `Skipped ${path}: file no longer exists.`,
            paths: [path],
          });
          continue;
        }

        const renamed = renameWithSuffix(path, buildSuffix("duplicate", input.nowIso));
        applied.push({
          id: duplicateRepair.id,
          code: duplicateRepair.code,
          status: "applied",
          details: `Renamed ${basename(path)} -> ${basename(renamed)}.`,
          paths: [path, renamed],
        });
      } catch (error: any) {
        applied.push({
          id: duplicateRepair.id,
          code: duplicateRepair.code,
          status: "failed",
          details: `Failed to quarantine duplicate daemon record ${path}: ${error?.message ?? String(error)}`,
          paths: [path],
        });
      }
    }
  }

  const unsafeCanonicalRepair = byId.get("quarantine-unsafe-canonical-daemon-record");
  if (unsafeCanonicalRepair) {
    for (const path of unsafeCanonicalRepair.paths) {
      if (input.dryRun) {
        applied.push({
          id: unsafeCanonicalRepair.id,
          code: unsafeCanonicalRepair.code,
          status: "skipped",
          details: `Dry run: would rename ${path}.`,
          paths: [path],
        });
        continue;
      }

      try {
        if (!existsSync(path)) {
          applied.push({
            id: unsafeCanonicalRepair.id,
            code: unsafeCanonicalRepair.code,
            status: "skipped",
            details: `Skipped ${path}: file no longer exists.`,
            paths: [path],
          });
          continue;
        }
        const renamed = renameWithSuffix(path, buildSuffix("corrupt", input.nowIso));
        applied.push({
          id: unsafeCanonicalRepair.id,
          code: unsafeCanonicalRepair.code,
          status: "applied",
          details: `Renamed ${basename(path)} -> ${basename(renamed)}.`,
          paths: [path, renamed],
        });
      } catch (error: any) {
        applied.push({
          id: unsafeCanonicalRepair.id,
          code: unsafeCanonicalRepair.code,
          status: "failed",
          details: `Failed to quarantine unsafe canonical daemon record ${path}: ${error?.message ?? String(error)}`,
          paths: [path],
        });
      }
    }
  }

  const cleanupLegacyControlRepair = byId.get("cleanup-legacy-control-files");
  if (cleanupLegacyControlRepair) {
    const canonicalControlPath =
      input.snapshot.controlCandidates.find((candidate) => candidate.is_canonical)?.path ?? null;
    if (!canonicalControlPath) {
      applied.push({
        id: cleanupLegacyControlRepair.id,
        code: cleanupLegacyControlRepair.code,
        status: "skipped",
        details: "Skipped cleanup: canonical control file path is unavailable.",
        paths: cleanupLegacyControlRepair.paths,
      });
    } else {
      for (const path of cleanupLegacyControlRepair.paths) {
        if (input.dryRun) {
          applied.push({
            id: cleanupLegacyControlRepair.id,
            code: cleanupLegacyControlRepair.code,
            status: "skipped",
            details: `Dry run: would rename ${path}.`,
            paths: [path],
          });
          continue;
        }

        try {
          if (!existsSync(path)) {
            applied.push({
              id: cleanupLegacyControlRepair.id,
              code: cleanupLegacyControlRepair.code,
              status: "skipped",
              details: `Skipped ${path}: file no longer exists.`,
              paths: [path],
            });
            continue;
          }
          if (hasLiveDaemonReferencingControl(path)) {
            applied.push({
              id: cleanupLegacyControlRepair.id,
              code: cleanupLegacyControlRepair.code,
              status: "skipped",
              details: `Skipped ${path}: referenced by a live daemon record.`,
              paths: [path],
            });
            continue;
          }

          const canonicalShape = parseControlShape(canonicalControlPath);
          const legacyShape = parseControlShape(path);
          if (!canonicalShape || !legacyShape || !sameControlShape(canonicalShape, legacyShape)) {
            applied.push({
              id: cleanupLegacyControlRepair.id,
              code: cleanupLegacyControlRepair.code,
              status: "skipped",
              details: `Skipped ${path}: control content no longer matches canonical state.`,
              paths: [path, canonicalControlPath],
            });
            continue;
          }

          const renamed = renameWithSuffix(path, buildSuffix("legacy", input.nowIso));
          applied.push({
            id: cleanupLegacyControlRepair.id,
            code: cleanupLegacyControlRepair.code,
            status: "applied",
            details: `Renamed ${basename(path)} -> ${basename(renamed)}.`,
            paths: [path, renamed],
          });
        } catch (error: any) {
          applied.push({
            id: cleanupLegacyControlRepair.id,
            code: cleanupLegacyControlRepair.code,
            status: "failed",
            details: `Failed to quarantine legacy control file ${path}: ${error?.message ?? String(error)}`,
            paths: [path],
          });
        }
      }
    }
  }

  const promoteRepair = byId.get("promote-live-daemon-record-to-canonical");
  if (promoteRepair) {
    const candidate = input.snapshot.daemonCandidates.find((entry) => entry.state === "live" && !entry.is_canonical && entry.record) ?? null;
    const canonicalPath = resolveDaemonRecordPath();
    const canonicalCandidate = input.snapshot.daemonCandidates.find((entry) => entry.is_canonical) ?? null;
    if (!candidate || !candidate.record) {
      applied.push({
        id: promoteRepair.id,
        code: promoteRepair.code,
        status: "skipped",
        details: "Skipped promotion: no live legacy daemon record candidate available.",
        paths: promoteRepair.paths,
      });
    } else if (classifyAuthorityRoot(dirname(candidate.path), authority) !== "managed-legacy") {
      applied.push({
        id: promoteRepair.id,
        code: promoteRepair.code,
        status: "skipped",
        details: `Skipped promotion: ${candidate.path} is not in a managed legacy root.`,
        paths: promoteRepair.paths,
      });
    } else if (!recordMatchesCanonicalControl(candidate.record, authority)) {
      applied.push({
        id: promoteRepair.id,
        code: promoteRepair.code,
        status: "skipped",
        details: "Skipped promotion: live legacy daemon record does not reference canonical control root/path.",
        paths: promoteRepair.paths,
      });
    } else if (countDistinctCurrentLiveIdentities() > 1) {
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
    } else if (canonicalCandidate?.exists && existsSync(canonicalPath)) {
      const canonicalRecord = readDaemonRecordAtPath(canonicalPath);
      if (!canonicalRecord) {
        applied.push({
          id: promoteRepair.id,
          code: promoteRepair.code,
          status: "skipped",
          details: "Skipped promotion: canonical daemon record already exists but is unreadable; requires manual review.",
          paths: promoteRepair.paths,
        });
      } else if (
        sameRecordShape(
          {
            daemonId: canonicalRecord.daemonId,
            pid: canonicalRecord.pid,
            controlRoot: canonicalRecord.controlRoot,
            controlFilePath: canonicalRecord.controlFilePath,
            cwd: canonicalRecord.cwd,
            command: canonicalRecord.command,
          },
          {
            daemonId: candidate.record.daemonId,
            pid: candidate.record.pid,
            controlRoot: candidate.record.controlRoot,
            controlFilePath: candidate.record.controlFilePath,
            cwd: candidate.record.cwd,
            command: candidate.record.command,
          }
        )
      ) {
        applied.push({
          id: promoteRepair.id,
          code: promoteRepair.code,
          status: "skipped",
          details: "Skipped promotion: canonical daemon record already matches live legacy source.",
          paths: promoteRepair.paths,
        });
      } else {
        applied.push({
          id: promoteRepair.id,
          code: promoteRepair.code,
          status: "skipped",
          details: "Skipped promotion: canonical daemon record already exists with different content; refusing to overwrite.",
          paths: promoteRepair.paths,
        });
      }
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
