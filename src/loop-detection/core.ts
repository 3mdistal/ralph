export type LoopDetectionThresholds = {
  /** Minimum number of apply_patch edits since the last detected gate command. */
  minEdits: number;
  /** Minimum elapsed wall time since the last detected gate command. */
  minElapsedMsWithoutGate: number;
  /** Minimum touches for the most-touched file. */
  minTopFileTouches: number;
  /** Minimum share (0..1) of touches that belong to the most-touched file. */
  minTopFileShare: number;
};

export type LoopDetectionConfig = {
  enabled: boolean;
  /** Deterministic allowlist of bash commands that count as a "gate". */
  gateMatchers: string[];
  /** Suggestion included in escalation handoff. */
  recommendedGateCommand: string;
  thresholds: LoopDetectionThresholds;
};

export type LoopFileStat = {
  path: string;
  touches: number;
};

export type LoopMetrics = {
  editsTotal: number;
  editsSinceGate: number;
  gateCommandCount: number;
  lastGateTs: number | null;
  firstEditSinceGateTs: number | null;
  topFiles: LoopFileStat[];
};

export type LoopTripInfo = {
  kind: "loop-trip";
  triggeredAtTs: number;
  reason: string;
  elapsedMsWithoutGate: number;
  thresholds: LoopDetectionThresholds;
  metrics: LoopMetrics;
};

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isLikelyGateCommand(command: string, matchers: string[]): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  for (const raw of matchers) {
    const matcher = normalizeCommand(raw);
    if (!matcher) continue;
    if (normalized === matcher) return true;
    if (normalized.startsWith(matcher + " ")) return true;
  }
  return false;
}

function parseApplyPatchTouchedFiles(patchText: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  const lines = patchText.split("\n");
  for (const raw of lines) {
    const line = raw.trimEnd();
    const match = line.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+?)\s*$/);
    if (match) {
      const path = match[1].trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
      continue;
    }

    const moved = line.match(/^\*\*\*\s+Move\s+to:\s+(.+?)\s*$/);
    if (moved) {
      const path = moved[1].trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }
  }

  return files;
}

function computeTopFiles(map: Map<string, number>, limit: number): LoopFileStat[] {
  const out: LoopFileStat[] = [];
  for (const [path, touches] of map.entries()) {
    if (!path) continue;
    if (!Number.isFinite(touches) || touches <= 0) continue;
    out.push({ path, touches });
  }
  out.sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path));
  return out.slice(0, Math.max(0, limit));
}

export type LoopDetector = {
  onToolStart: (params: { toolName: string; input: unknown; now: number }) => LoopTripInfo | null;
  getMetrics: () => LoopMetrics;
  getTrip: () => LoopTripInfo | null;
};

export function createLoopDetector(params: { config: LoopDetectionConfig; startTs: number }): LoopDetector {
  const cfg = params.config;
  const startTs = params.startTs;

  let editsTotal = 0;
  let editsSinceGate = 0;
  let gateCommandCount = 0;
  let lastGateTs: number | null = null;
  let firstEditSinceGateTs: number | null = null;
  const touchesSinceGate = new Map<string, number>();

  let trip: LoopTripInfo | null = null;

  const resetSinceGate = (now: number) => {
    editsSinceGate = 0;
    firstEditSinceGateTs = null;
    touchesSinceGate.clear();
    lastGateTs = now;
  };

  const buildMetrics = (): LoopMetrics => {
    return {
      editsTotal,
      editsSinceGate,
      gateCommandCount,
      lastGateTs,
      firstEditSinceGateTs,
      topFiles: computeTopFiles(touchesSinceGate, 10),
    };
  };

  const evaluate = (now: number): LoopTripInfo | null => {
    if (!cfg.enabled) return null;
    if (trip) return trip;
    if (editsSinceGate < cfg.thresholds.minEdits) return null;

    const sinceGateBase = lastGateTs ?? firstEditSinceGateTs ?? startTs;
    const elapsedMsWithoutGate = Math.max(0, now - sinceGateBase);
    if (elapsedMsWithoutGate < cfg.thresholds.minElapsedMsWithoutGate) return null;

    const topFiles = computeTopFiles(touchesSinceGate, 10);
    const totalTouches = Array.from(touchesSinceGate.values()).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
    const top = topFiles[0];
    const topTouches = top?.touches ?? 0;
    const share = totalTouches > 0 ? topTouches / totalTouches : 0;

    if (topTouches < cfg.thresholds.minTopFileTouches) return null;
    if (share < cfg.thresholds.minTopFileShare) return null;

    const metrics = buildMetrics();
    trip = {
      kind: "loop-trip",
      triggeredAtTs: now,
      reason: "Edit churn without gates exceeded thresholds",
      elapsedMsWithoutGate,
      thresholds: cfg.thresholds,
      metrics,
    };
    return trip;
  };

  const onToolStart = (input: { toolName: string; input: unknown; now: number }): LoopTripInfo | null => {
    if (!cfg.enabled) return null;
    if (trip) return trip;

    const toolName = String(input.toolName ?? "");

    if (toolName === "bash") {
      const cmd = (input.input as any)?.command;
      if (typeof cmd === "string" && isLikelyGateCommand(cmd, cfg.gateMatchers)) {
        gateCommandCount += 1;
        resetSinceGate(input.now);
      }
      return null;
    }

    if (toolName === "apply_patch") {
      editsTotal += 1;
      editsSinceGate += 1;
      if (firstEditSinceGateTs == null) firstEditSinceGateTs = input.now;

      const patchText = (input.input as any)?.patchText;
      if (typeof patchText === "string" && patchText) {
        const files = parseApplyPatchTouchedFiles(patchText);
        for (const file of files) {
          const prev = touchesSinceGate.get(file) ?? 0;
          touchesSinceGate.set(file, prev + 1);
        }
      }

      return evaluate(input.now);
    }

    return null;
  };

  return {
    onToolStart,
    getMetrics: buildMetrics,
    getTrip: () => trip,
  };
}
