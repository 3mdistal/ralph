import { parseStrictFinalLineJsonMarker, type StrictJsonMarkerParseFailure } from "../markers";

const RALPH_BUILD_EVIDENCE_MARKER_PREFIX = "RALPH_BUILD_EVIDENCE";
const RALPH_BUILD_EVIDENCE_VERSION = 1;

type BuildPreflightStatus = "pass" | "fail" | "skipped";

export type RalphBuildEvidence = {
  version: number;
  branch: string;
  base: string;
  head_sha: string;
  worktree_clean: boolean;
  preflight: {
    status: BuildPreflightStatus;
    command: string;
    summary: string;
  };
  ready_for_pr_create: boolean;
};

type BuildEvidenceParseFailure = StrictJsonMarkerParseFailure | "invalid_payload";

export type RalphBuildEvidenceParseResult =
  | { ok: true; evidence: RalphBuildEvidence; markerLine: string }
  | { ok: false; failure: BuildEvidenceParseFailure; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePreflight(record: Record<string, unknown>): RalphBuildEvidence["preflight"] | null {
  const raw = record.preflight;
  if (!isRecord(raw)) return null;

  const status = raw.status;
  if (status !== "pass" && status !== "fail" && status !== "skipped") return null;

  const command = readNonEmptyString(raw, "command");
  const summary = readNonEmptyString(raw, "summary");
  if (!command || !summary) return null;

  return { status, command, summary };
}

function isValidHeadSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

export function parseRalphBuildEvidenceMarker(output: string): RalphBuildEvidenceParseResult {
  const parsed = parseStrictFinalLineJsonMarker<unknown>(output, RALPH_BUILD_EVIDENCE_MARKER_PREFIX);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: parsed.failure,
      error: parsed.error,
    };
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, failure: "invalid_payload", error: "Build evidence payload must be a JSON object" };
  }

  const version = parsed.value.version;
  if (version !== RALPH_BUILD_EVIDENCE_VERSION) {
    return {
      ok: false,
      failure: "invalid_payload",
      error: `Build evidence version must be ${RALPH_BUILD_EVIDENCE_VERSION}`,
    };
  }

  const branch = readNonEmptyString(parsed.value, "branch");
  const base = readNonEmptyString(parsed.value, "base");
  const headSha = readNonEmptyString(parsed.value, "head_sha");
  const worktreeClean = parsed.value.worktree_clean;
  const readyForPrCreate = parsed.value.ready_for_pr_create;
  const preflight = parsePreflight(parsed.value);

  if (!branch || !base || !headSha || !isValidHeadSha(headSha) || typeof worktreeClean !== "boolean" || !preflight || typeof readyForPrCreate !== "boolean") {
    return {
      ok: false,
      failure: "invalid_payload",
      error: "Build evidence payload is missing required fields",
    };
  }

  return {
    ok: true,
    markerLine: parsed.markerLine,
    evidence: {
      version,
      branch,
      base,
      head_sha: headSha,
      worktree_clean: worktreeClean,
      preflight,
      ready_for_pr_create: readyForPrCreate,
    },
  };
}
