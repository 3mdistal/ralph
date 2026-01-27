import {
  getLatestRunGateStateForIssue,
  getStateSchemaVersion,
  initStateDb,
  RalphRunGateState,
} from "../state";

const GATES_JSON_SCHEMA_VERSION = 1;

export function buildGateJsonPayload(params: {
  repo: string;
  issueNumber: number;
  state: RalphRunGateState | null;
}): {
  schema_version: number;
  state_schema_version: number;
  repo: string;
  issueNumber: number;
  runId: string | null;
  results: RalphRunGateState["results"];
  artifacts: RalphRunGateState["artifacts"];
} {
  const runId = params.state?.results[0]?.runId ?? null;
  return {
    schema_version: GATES_JSON_SCHEMA_VERSION,
    state_schema_version: getStateSchemaVersion(),
    repo: params.repo,
    issueNumber: params.issueNumber,
    runId,
    results: params.state?.results ?? [],
    artifacts: params.state?.artifacts ?? [],
  };
}

function parseIssueNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
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
    console.log(
      JSON.stringify(
        buildGateJsonPayload({ repo, issueNumber, state }),
        null,
        2
      )
    );
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
    if (result.url) console.log(`  url: ${result.url}`);
    if (result.prNumber) console.log(`  pr: #${result.prNumber}`);
    if (result.prUrl) console.log(`  pr url: ${result.prUrl}`);
  }

  if (state.artifacts.length > 0) {
    console.log("Artifacts:");
    for (const artifact of state.artifacts) {
      console.log(
        `- ${artifact.gate}/${artifact.kind}${artifact.truncated ? " (truncated)" : ""}`
      );
      const lines = artifact.content.split("\n");
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    }
  }
}
