import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";

import { recordRalphRunGateArtifact, upsertRalphRunGateResult } from "../state";
import { getRalphRunArtifactsDir } from "../paths";

import type { SessionResult } from "../session";

export type ReviewGateName = "product_review" | "devex_review";

type ReviewMarkerParseFailure =
  | "empty_output"
  | "missing_marker"
  | "multiple_markers"
  | "marker_not_final_line"
  | "missing_json"
  | "invalid_json"
  | "invalid_status"
  | "missing_reason";

type ReviewMarkerParseResult =
  | { ok: true; status: "pass" | "fail"; reason: string; markerLine: string }
  | { ok: false; failure: ReviewMarkerParseFailure; reason: string };

export type ReviewDiffArtifacts = {
  baseRef: string;
  headRef: string;
  diffPath: string;
  diffStat: string;
};

export type ReviewGateResult = {
  status: "pass" | "fail";
  reason: string;
  sessionId?: string;
};

const REVIEW_MARKER_PREFIX = "RALPH_REVIEW:";
const REVIEW_MARKER_REGEX = /^\s*RALPH_REVIEW\b\s*[:\-]?\s*/i;
const MARKDOWN_FENCE_LINE_REGEX = /^```(?:[a-z0-9_-]+)?$/i;

function tryParseReviewPayload(jsonText: string):
  | { ok: true; status: "pass" | "fail"; reason: string }
  | { ok: false; reason: string } {
  if (!jsonText.trim()) {
    return { ok: false, reason: "Review marker invalid: missing JSON payload" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error: any) {
    return {
      ok: false,
      reason: `Review marker invalid: malformed JSON (${error?.message ?? String(error)})`,
    };
  }

  const status = parsed?.status;
  if (status !== "pass" && status !== "fail") {
    return { ok: false, reason: "Review marker invalid: status must be pass|fail" };
  }

  const reason = typeof parsed?.reason === "string" ? parsed.reason.trim() : "";
  if (!reason) {
    return { ok: false, reason: "Review marker invalid: reason is required" };
  }

  return { ok: true, status, reason };
}

function tryParseFallbackPayload(lines: string[], lastNonEmptyIndex: number):
  | { ok: true; status: "pass" | "fail"; reason: string }
  | { ok: false } {
  const candidates: string[] = [];
  const lastLine = lines[lastNonEmptyIndex].trim();

  candidates.push(lastLine);

  if (lastLine.startsWith("`") && lastLine.endsWith("`") && lastLine.length >= 2) {
    candidates.push(lastLine.replace(/^`+|`+$/g, "").trim());
  }

  if (lastLine === "```") {
    let i = lastNonEmptyIndex - 1;
    while (i >= 0 && !lines[i].trim()) i -= 1;
    if (i >= 0) {
      candidates.push(lines[i].trim());
    }
  }

  for (let start = lastNonEmptyIndex; start >= 0; start -= 1) {
    if (lines[start].includes("{")) {
      candidates.push(lines.slice(start, lastNonEmptyIndex + 1).join("\n").trim());
      break;
    }
  }

  for (const candidate of candidates) {
    const parsed = tryParseReviewPayload(candidate);
    if (parsed.ok) {
      return parsed;
    }
  }

  return { ok: false };
}

export function parseRalphReviewMarker(output: string): ReviewMarkerParseResult {
  const text = String(output ?? "");
  const lines = text.split(/\r?\n/);
  let rawLastNonEmptyIndex = -1;
  const markerIndices: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed) rawLastNonEmptyIndex = i;
    if (REVIEW_MARKER_REGEX.test(line)) {
      markerIndices.push(i);
    }
  }

  if (rawLastNonEmptyIndex < 0) {
    return {
      ok: false,
      failure: "empty_output",
      reason: "Review marker invalid: output was empty",
    };
  }

  let lastNonEmptyIndex = rawLastNonEmptyIndex;
  while (lastNonEmptyIndex >= 0) {
    const line = lines[lastNonEmptyIndex].trim();
    if (!line || MARKDOWN_FENCE_LINE_REGEX.test(line)) {
      lastNonEmptyIndex -= 1;
      continue;
    }
    break;
  }

  if (lastNonEmptyIndex < 0) {
    return {
      ok: false,
      failure: "empty_output",
      reason: "Review marker invalid: output was empty",
    };
  }

  if (markerIndices.length === 0) {
    const fallbackPayload = tryParseFallbackPayload(lines, lastNonEmptyIndex);
    if (fallbackPayload.ok) {
      return {
        ok: true,
        status: fallbackPayload.status,
        reason: fallbackPayload.reason,
        markerLine: `${REVIEW_MARKER_PREFIX} ${lines[lastNonEmptyIndex].trim()}`,
      };
    }
    return {
      ok: false,
      failure: "missing_marker",
      reason: "Review marker invalid: missing RALPH_REVIEW on final line",
    };
  }

  if (markerIndices.length > 1) {
    return {
      ok: false,
      failure: "multiple_markers",
      reason: "Review marker invalid: multiple RALPH_REVIEW lines",
    };
  }

  if (markerIndices[0] !== lastNonEmptyIndex) {
    return {
      ok: false,
      failure: "marker_not_final_line",
      reason: "Review marker invalid: RALPH_REVIEW not on final line",
    };
  }

  const markerLine = lines[lastNonEmptyIndex].trim();
  if (!REVIEW_MARKER_REGEX.test(markerLine)) {
    return {
      ok: false,
      failure: "missing_marker",
      reason: "Review marker invalid: missing RALPH_REVIEW on final line",
    };
  }

  const jsonText = markerLine.replace(REVIEW_MARKER_REGEX, "").trim();
  const payload = tryParseReviewPayload(jsonText);
  if (!payload.ok) {
    const reason = payload.reason;
    if (reason.includes("missing JSON payload")) {
      return { ok: false, failure: "missing_json", reason };
    }
    if (reason.includes("malformed JSON")) {
      return { ok: false, failure: "invalid_json", reason };
    }
    if (reason.includes("status must be")) {
      return { ok: false, failure: "invalid_status", reason };
    }
    return { ok: false, failure: "missing_reason", reason };
  }

  return { ok: true, status: payload.status, reason: payload.reason, markerLine };
}

function buildReviewPrompt(params: {
  repo: string;
  issueRef: string;
  prUrl: string;
  baseRef: string;
  headRef: string;
  diffPath: string;
  diffStat: string;
  issueContext?: string;
}): string {
  const stat = params.diffStat.trim() || "(no changes)";
  const issueContext = params.issueContext?.trim();

  const lines = [
    "Review request (deterministic gate)",
    `Repo: ${params.repo}`,
    `Issue: ${params.issueRef}`,
    `PR: ${params.prUrl}`,
    `Base: ${params.baseRef}`,
    `Head: ${params.headRef}`,
    "",
    "Diff artifact (read this file; do not request pasted diff chunks):",
    params.diffPath,
    "",
    "git diff --stat:",
    stat,
  ];

  if (issueContext) {
    lines.push("", "Issue context:", issueContext);
  }

  lines.push(
    "",
    "Return the required RALPH_REVIEW marker on the final line.",
    "Final line format:",
    'RALPH_REVIEW: {"status":"pass"|"fail","reason":"..."}',
    "Do not add any text after the marker line."
  );

  return lines.join("\n");
}

function buildReviewRepairPrompt(reason: string): string {
  return [
    "Your prior review response failed deterministic marker parsing.",
    `Parser error: ${reason}`,
    "Re-emit your decision as exactly one final line with valid JSON:",
    'RALPH_REVIEW: {"status":"pass"|"fail","reason":"..."}',
    "No code fences.",
    "No extra lines before or after.",
  ].join("\n");
}

const MAX_REPAIR_ATTEMPTS = 2;

function buildDiffArtifactNote(params: ReviewDiffArtifacts): string {
  const stat = params.diffStat.trim() || "(no changes)";
  return [
    "Review diff artifact:",
    `Path: ${params.diffPath}`,
    `Base: ${params.baseRef}`,
    `Head: ${params.headRef}`,
    "git diff --stat:",
    stat,
  ].join("\n");
}

async function execGitCommand(params: { cwd: string; args: string[] }): Promise<string> {
  return await new Promise((resolve, reject) => {
    const proc = spawn("git", params.args, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (error: Error) => reject(error));
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      reject(new Error(`git ${params.args.join(" ")} failed (code ${code})${suffix}`));
    });
  });
}

export async function prepareReviewDiffArtifacts(params: {
  runId: string;
  repoPath: string;
  baseRef: string;
  headRef: string;
  execGit?: (args: string[]) => Promise<string>;
}): Promise<ReviewDiffArtifacts> {
  const execGit = params.execGit ?? ((args: string[]) => execGitCommand({ cwd: params.repoPath, args }));
  const artifactsDir = getRalphRunArtifactsDir(params.runId);
  await mkdir(artifactsDir, { recursive: true });

  const diffPath = join(artifactsDir, "review-diff.patch");
  const baseRef = params.baseRef.trim();
  const headRef = params.headRef.trim();

  if (baseRef) {
    await execGit(["fetch", "origin", baseRef]);
  }
  if (headRef) {
    await execGit(["fetch", "origin", headRef]);
  }

  const baseForDiff = baseRef ? `origin/${baseRef}` : "";
  const range = baseForDiff && headRef ? `${baseForDiff}...${headRef}` : "";
  if (!range) {
    throw new Error("Missing base/head refs for review diff");
  }

  const diffStat = (await execGit(["diff", "--stat", range])).trim();
  const diffText = await execGit(["diff", range]);
  await writeFile(diffPath, diffText, "utf8");

  return {
    baseRef,
    headRef,
    diffPath,
    diffStat,
  };
}

export function recordReviewGateFailure(params: { runId: string; gate: ReviewGateName; reason: string }): void {
  upsertRalphRunGateResult({
    runId: params.runId,
    gate: params.gate,
    status: "fail",
    reason: params.reason,
  });
}

export function recordReviewGateSkipped(params: { runId: string; gate: ReviewGateName; reason: string }): void {
  upsertRalphRunGateResult({
    runId: params.runId,
    gate: params.gate,
    status: "skipped",
    reason: params.reason,
  });
}

export async function runReviewGate(params: {
  runId: string;
  gate: ReviewGateName;
  repo: string;
  issueRef: string;
  prUrl: string;
  issueContext?: string;
  diff: ReviewDiffArtifacts;
  runAgent: (prompt: string) => Promise<SessionResult>;
}): Promise<ReviewGateResult> {
  const { runId, gate, diff } = params;
  upsertRalphRunGateResult({ runId, gate, status: "pending" });
  recordRalphRunGateArtifact({ runId, gate, kind: "note", content: buildDiffArtifactNote(diff) });

  const prompt = buildReviewPrompt({
    repo: params.repo,
    issueRef: params.issueRef,
    prUrl: params.prUrl,
    baseRef: diff.baseRef,
    headRef: diff.headRef,
    diffPath: diff.diffPath,
    diffStat: diff.diffStat,
    issueContext: params.issueContext,
  });

  let result: SessionResult;
  try {
    result = await params.runAgent(prompt);
  } catch (error: any) {
    const reason = `Review agent failed: ${error?.message ?? String(error)}`;
    upsertRalphRunGateResult({ runId, gate, status: "fail", reason });
    recordRalphRunGateArtifact({
      runId,
      gate,
      kind: "note",
      content: `Review agent error:\n${reason}`,
    });
    return { status: "fail", reason };
  }

  const output = result.output ?? "";
  recordRalphRunGateArtifact({
    runId,
    gate,
    kind: "note",
    content: ["Review output:", output].join("\n").trim(),
  });

  if (!result.success) {
    const reason = "Review agent did not complete successfully";
    upsertRalphRunGateResult({ runId, gate, status: "fail", reason });
    return { status: "fail", reason, sessionId: result.sessionId };
  }

  let parsed = parseRalphReviewMarker(output);
  let finalSessionId = result.sessionId;
  let lastParseReason = parsed.ok ? "" : parsed.reason;

  for (let attempt = 1; !parsed.ok && attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const repairPrompt = buildReviewRepairPrompt(lastParseReason);
    recordRalphRunGateArtifact({
      runId,
      gate,
      kind: "note",
      content: [`Review marker parse failed (attempt ${attempt}); requesting repair:`, lastParseReason].join("\n"),
    });

    try {
      const repair = await params.runAgent(repairPrompt);
      finalSessionId = repair.sessionId ?? finalSessionId;
      const repairedOutput = repair.output ?? "";
      recordRalphRunGateArtifact({
        runId,
        gate,
        kind: "note",
        content: [`Review repair output (attempt ${attempt}):`, repairedOutput].join("\n").trim(),
      });

      if (!repair.success) {
        lastParseReason = "Review repair attempt did not complete successfully";
        continue;
      }

      parsed = parseRalphReviewMarker(repairedOutput);
      if (!parsed.ok) {
        lastParseReason = parsed.reason;
      }
    } catch {
      lastParseReason = "Review repair attempt failed to execute";
    }
  }

  if (!parsed.ok) {
    upsertRalphRunGateResult({ runId, gate, status: "fail", reason: parsed.reason });
    return { status: "fail", reason: parsed.reason, sessionId: finalSessionId };
  }

  upsertRalphRunGateResult({ runId, gate, status: parsed.status, reason: parsed.reason });
  return { status: parsed.status, reason: parsed.reason, sessionId: finalSessionId };
}
