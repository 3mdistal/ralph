import {
  getLatestRunGateStateForIssue,
  initStateDb,
  type GateArtifactKind,
  type GateName,
  type GateStatus,
  type RalphRunGateState,
} from "../state";

function parseIssueNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

type GateResultProjection = {
  name: GateName;
  status: GateStatus;
  command: string | null;
  skipReason: string | null;
  reason: string | null;
  url: string | null;
  prNumber: number | null;
  prUrl: string | null;
};

type GateArtifactProjection = {
  gate: GateName;
  kind: GateArtifactKind;
  truncated: boolean;
  content: string;
};

export type GatesJsonOutput = {
  version: 2;
  repo: string;
  issueNumber: number;
  runId: string | null;
  gates: GateResultProjection[];
  artifacts: GateArtifactProjection[];
};

export function buildGatesJsonOutput(params: {
  repo: string;
  issueNumber: number;
  state: RalphRunGateState | null;
}): GatesJsonOutput {
  const runId = params.state?.results[0]?.runId ?? null;
  const results = params.state?.results ?? [];
  const artifacts = params.state?.artifacts ?? [];

  return {
    version: 2,
    repo: params.repo,
    issueNumber: params.issueNumber,
    runId,
    gates: results.map((result) => ({
      name: result.gate,
      status: result.status,
      command: result.command,
      skipReason: result.skipReason,
      reason: result.reason,
      url: result.url,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
    })),
    artifacts: artifacts.map((artifact) => ({
      gate: artifact.gate,
      kind: artifact.kind,
      truncated: artifact.truncated,
      content: artifact.content,
    })),
  };
}

export async function runGatesCommand(opts: { args: string[] }): Promise<void> {
  const json = opts.args.includes("--json");
  const positional = opts.args.filter((arg) => !arg.startsWith("-"));
  const repo = positional[1] ?? "";
  const issueNumber = parseIssueNumber(positional[2]);

  if (!repo || issueNumber === null) {
    console.error("Usage: ralph gates <repo> <issueNumber> [--json]");
    process.exit(1);
    return;
  }

  initStateDb();
  const state = getLatestRunGateStateForIssue({ repo, issueNumber });

  if (json) {
    console.log(JSON.stringify(buildGatesJsonOutput({ repo, issueNumber, state }), null, 2));
    process.exit(0);
    return;
  }

  if (!state || state.results.length === 0) {
    console.log(`No gate state found for ${repo}#${issueNumber}.`);
    process.exit(0);
    return;
  }

  const runId = state.results[0]?.runId ?? "(unknown)";
  console.log(`Gate state for ${repo}#${issueNumber} (run ${runId}):`);

  for (const result of state.results) {
    console.log(`- ${result.gate}: ${result.status}`);
    if (result.command) console.log(`  command: ${result.command}`);
    if (result.skipReason) console.log(`  skip reason: ${result.skipReason}`);
    if (result.reason) console.log(`  reason: ${result.reason}`);
    if (result.url) console.log(`  url: ${result.url}`);
    if (result.prNumber) console.log(`  pr: #${result.prNumber}`);
    if (result.prUrl) console.log(`  pr url: ${result.prUrl}`);
  }

  if (state.artifacts.length > 0) {
    console.log("Artifacts:");
    for (const artifact of state.artifacts) {
      console.log(`- ${artifact.gate}/${artifact.kind}${artifact.truncated ? " (truncated)" : ""}`);
      const lines = artifact.content.split("\n");
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    }
  }
}
