import {
  classifyDurableStateInitError,
  getLatestRunGateStateForIssueReadonly,
  getLatestRunGateStateForIssue,
  initStateDb,
  isDurableStateInitError,
  probeDurableState,
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
  createdAt: string;
  updatedAt: string;
  command: string | null;
  skipReason: string | null;
  reason: string | null;
  url: string | null;
  prNumber: number | null;
  prUrl: string | null;
};

type GateArtifactProjection = {
  id: number;
  gate: GateName;
  kind: GateArtifactKind;
  createdAt: string;
  updatedAt: string;
  truncated: boolean;
  truncationMode: "head" | "tail";
  artifactPolicyVersion: number;
  originalChars: number | null;
  originalLines: number | null;
  content: string;
};

type GatesErrorOutput = {
  code: string;
  message: string;
  schemaVersion?: number;
  supportedRange?: string;
  writableRange?: string;
};

export type GatesJsonOutput = {
  version: 2;
  repo: string;
  issueNumber: number;
  runId: string | null;
  gates: GateResultProjection[];
  artifacts: GateArtifactProjection[];
  error: GatesErrorOutput | null;
};

const GATE_ORDER: GateName[] = ["preflight", "plan_review", "product_review", "devex_review", "ci", "pr_evidence"];

const MAX_EXCERPT_LINES = 3;
const MAX_EXCERPT_CHARS = 160;

function gateOrder(gate: GateName): number {
  const idx = GATE_ORDER.indexOf(gate);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

function buildArtifactExcerpt(content: string): string[] {
  const lines = content.split("\n");
  const excerpt = lines.slice(0, MAX_EXCERPT_LINES).map((line) => {
    if (line.length <= MAX_EXCERPT_CHARS) return line;
    return `${line.slice(0, MAX_EXCERPT_CHARS - 3)}...`;
  });
  const hiddenLineCount = lines.length - excerpt.length;
  if (hiddenLineCount > 0) {
    excerpt.push(`... (${hiddenLineCount} more lines)`);
  }
  return excerpt;
}

function buildErrorOutput(error: ReturnType<typeof classifyDurableStateInitError>): GatesErrorOutput {
  return {
    code: error.code,
    message: error.message,
    schemaVersion: error.schemaVersion,
    supportedRange: error.supportedRange,
    writableRange: error.writableRange,
  };
}

export function buildGatesJsonOutput(params: {
  repo: string;
  issueNumber: number;
  state: RalphRunGateState | null;
  error?: GatesErrorOutput | null;
}): GatesJsonOutput {
  const runId = params.state?.results[0]?.runId ?? null;
  const results = [...(params.state?.results ?? [])].sort((left, right) => {
    const orderDelta = gateOrder(left.gate) - gateOrder(right.gate);
    if (orderDelta !== 0) return orderDelta;
    return left.gate.localeCompare(right.gate);
  });
  const artifacts = [...(params.state?.artifacts ?? [])].sort((left, right) => left.id - right.id);

  return {
    version: 2,
    repo: params.repo,
    issueNumber: params.issueNumber,
    runId,
    gates: results.map((result) => ({
      name: result.gate,
      status: result.status,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      command: result.command,
      skipReason: result.skipReason,
      reason: result.reason,
      url: result.url,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      gate: artifact.gate,
      kind: artifact.kind,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      truncated: artifact.truncated,
      truncationMode: artifact.truncationMode,
      artifactPolicyVersion: artifact.artifactPolicyVersion,
      originalChars: artifact.originalChars,
      originalLines: artifact.originalLines,
      content: artifact.content,
    })),
    error: params.error ?? null,
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

  const emitDurableStateError = (error: ReturnType<typeof classifyDurableStateInitError>) => {
    if (json) {
      console.log(
        JSON.stringify(
          buildGatesJsonOutput({
            repo,
            issueNumber,
            state: null,
            error: buildErrorOutput(error),
          }),
          null,
          2
        )
      );
    } else {
      console.error(`Unable to read durable state (${error.code}): ${error.message}`);
    }
    process.exit(2);
  };

  const probe = probeDurableState();
  if (!probe.ok) {
    emitDurableStateError(probe);
    return;
  }

  let state: RalphRunGateState | null;
  if (probe.canWriteState === false) {
    state = getLatestRunGateStateForIssueReadonly({ repo, issueNumber });
  } else {
    try {
      initStateDb();
      state = getLatestRunGateStateForIssue({ repo, issueNumber });
    } catch (error) {
      if (!isDurableStateInitError(error)) {
        throw error;
      }
      emitDurableStateError(classifyDurableStateInitError(error));
      return;
    }
  }

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

  const orderedResults = [...state.results].sort((left, right) => {
    const orderDelta = gateOrder(left.gate) - gateOrder(right.gate);
    if (orderDelta !== 0) return orderDelta;
    return left.gate.localeCompare(right.gate);
  });

  for (const result of orderedResults) {
    console.log(`- ${result.gate}: ${result.status} (updated ${result.updatedAt})`);
    if (result.command) console.log(`  command: ${result.command}`);
    if (result.skipReason) console.log(`  skip reason: ${result.skipReason}`);
    if (result.reason) console.log(`  reason: ${result.reason}`);
    if (result.url) console.log(`  url: ${result.url}`);
    if (result.prNumber) console.log(`  pr: #${result.prNumber}`);
    if (result.prUrl) console.log(`  pr url: ${result.prUrl}`);
  }

  if (state.artifacts.length > 0) {
    console.log("Artifacts:");
    const orderedArtifacts = [...state.artifacts].sort((left, right) => left.id - right.id);
    for (const artifact of orderedArtifacts) {
      console.log(
        `- #${artifact.id} ${artifact.gate}/${artifact.kind}${artifact.truncated ? " (truncated)" : ""} ` +
          `[${artifact.updatedAt}]`
      );
      for (const line of buildArtifactExcerpt(artifact.content)) {
        console.log(`  ${line}`);
      }
    }
  }

  process.exit(0);
}
