import { GitHubClient } from "../github/client";
import { writeAlertToGitHub } from "../github/alert-writeback";
import { writeRollupReadyToGitHub } from "../github/rollup-ready-writeback";
import { initStateDb, recordAlertOccurrence } from "../state";
import { buildAlertFingerprintFromSeed, formatAlertDetails, formatAlertSummary, planAlertRecord } from "./core";

export async function recordIssueErrorAlert(params: {
  repo: string;
  issueNumber: number;
  taskName?: string;
  context: string;
  error: string;
}): Promise<void> {
  initStateDb();
  const planned = planAlertRecord({
    kind: "error",
    targetType: "issue",
    targetNumber: params.issueNumber,
    context: params.context,
    error: params.error,
  });

  const alert = recordAlertOccurrence({
    repo: params.repo,
    targetType: planned.targetType,
    targetNumber: planned.targetNumber,
    kind: planned.kind,
    fingerprint: planned.fingerprint,
    summary: planned.summary,
    details: planned.details,
  });

  const github = new GitHubClient(params.repo);
  await writeAlertToGitHub(
    {
      repo: params.repo,
      issueNumber: params.issueNumber,
      taskName: params.taskName,
      kind: planned.kind,
      fingerprint: planned.fingerprint,
      alertId: alert.id,
      summary: alert.summary,
      details: alert.details,
      count: alert.count,
      lastSeenAt: alert.lastSeenAt,
    },
    { github }
  );
}

export async function recordIssueAlert(params: {
  repo: string;
  issueNumber: number;
  taskName?: string;
  kind: "error";
  fingerprintSeed: string;
  summary: string;
  details?: string | null;
}): Promise<void> {
  initStateDb();
  const fingerprint = buildAlertFingerprintFromSeed(params.fingerprintSeed);
  const summary = formatAlertSummary(params.summary);
  const details = params.details ? formatAlertDetails(params.details) : null;
  const alert = recordAlertOccurrence({
    repo: params.repo,
    targetType: "issue",
    targetNumber: params.issueNumber,
    kind: params.kind,
    fingerprint,
    summary,
    details,
  });

  const github = new GitHubClient(params.repo);
  await writeAlertToGitHub(
    {
      repo: params.repo,
      issueNumber: params.issueNumber,
      taskName: params.taskName,
      kind: params.kind,
      fingerprint,
      alertId: alert.id,
      summary: alert.summary,
      details: alert.details,
      count: alert.count,
      lastSeenAt: alert.lastSeenAt,
    },
    { github }
  );
}

export function recordRepoErrorAlert(params: { repo: string; context: string; error: string }): void {
  initStateDb();
  const planned = planAlertRecord({
    kind: "error",
    targetType: "repo",
    targetNumber: 0,
    context: params.context,
    error: params.error,
  });

  recordAlertOccurrence({
    repo: params.repo,
    targetType: planned.targetType,
    targetNumber: planned.targetNumber,
    kind: planned.kind,
    fingerprint: planned.fingerprint,
    summary: planned.summary,
    details: planned.details,
  });
}

export async function recordRollupReadyAlert(params: {
  repo: string;
  prNumber: number | null;
  prUrl: string;
  mergedPRs: string[];
}): Promise<void> {
  initStateDb();
  const details = [
    `Rollup PR: ${params.prUrl}`,
    params.mergedPRs.length ? "Included PRs:" : "",
    ...params.mergedPRs.map((pr) => `- ${pr}`),
  ]
    .filter(Boolean)
    .join("\n");

  const planned = planAlertRecord({
    kind: "rollup-ready",
    targetType: "repo",
    targetNumber: 0,
    context: `Rollup ready (${params.repo})`,
    error: details,
  });

  recordAlertOccurrence({
    repo: params.repo,
    targetType: planned.targetType,
    targetNumber: planned.targetNumber,
    kind: planned.kind,
    fingerprint: planned.fingerprint,
    summary: planned.summary,
    details: planned.details,
  });

  if (params.prNumber && Number.isFinite(params.prNumber)) {
    const github = new GitHubClient(params.repo);
    await writeRollupReadyToGitHub(
      {
        repo: params.repo,
        prNumber: params.prNumber,
        prUrl: params.prUrl,
        mergedPRs: params.mergedPRs,
      },
      { github }
    );
  }
}
