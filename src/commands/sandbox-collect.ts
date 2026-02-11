import { resolve } from "path";

import { initStateDb } from "../state";
import { collectSandboxTraceBundle } from "../sandbox/collect";

function printSandboxCollectHelp(): void {
  console.log(
    [
      "Usage:",
      "  ralph sandbox:collect --run-id <id> [--out <path>] [--json]",
      "",
      "Options:",
      "  --run-id <id>   Ralph run id to export (required)",
      "  --out <path>    Output directory (default: ~/.ralph/artifacts/<runId>/trace-bundle)",
      "  --json          Emit machine-readable output",
    ].join("\n")
  );
}

function getArgValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return null;
  return value.trim();
}

export async function runSandboxCollectCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSandboxCollectHelp();
    process.exit(0);
  }

  const runId = getArgValue(args, "--run-id");
  if (!runId) {
    console.error("[ralph:sandbox] Missing required --run-id <id>.");
    printSandboxCollectHelp();
    process.exit(1);
  }

  const outRaw = getArgValue(args, "--out");
  const out = outRaw ? resolve(outRaw) : undefined;
  const json = args.includes("--json");

  initStateDb();

  const result = await collectSandboxTraceBundle({ runId, outputDir: out });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`[ralph:sandbox] Collected trace bundle for ${result.runId}`);
  console.log(`[ralph:sandbox] Output: ${result.outputDir}`);
  console.log(`[ralph:sandbox] Timeline: ${result.workerToolTimelinePath}`);
  console.log(`[ralph:sandbox] GitHub requests: ${result.githubRequestsPath}`);
  process.exit(0);
}
