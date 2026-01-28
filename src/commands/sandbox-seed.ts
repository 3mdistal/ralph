import { resolve } from "path";
import { runSeedSuite } from "../sandbox/seed-suite";

type SeedArgs = {
  repo: string;
  manifestPath: string;
  outputPath: string;
  dryRun: boolean;
  json: boolean;
  verify: boolean;
  force: boolean;
  maxScanPages: number;
};

const DEFAULT_MANIFEST = "sandbox/seed-manifest.v1.json";
const DEFAULT_OUTPUT = "sandbox/seed-ids.v1.json";

export function printSandboxSeedHelp(): void {
  console.log(
    [
      "Usage:",
      "  ralph sandbox seed --repo <owner/repo> [options]",
      "",
      "Options:",
      "  --repo <owner/repo>   Target sandbox repo (required)",
      "  --manifest <path>     Seed manifest path (default: sandbox/seed-manifest.v1.json)",
      "  --out <path>          Output seed IDs JSON (default: sandbox/seed-ids.v1.json)",
      "  --dry-run             Print planned operations without mutating GitHub",
      "  --json                Emit JSON output (use with --dry-run)",
      "  --no-verify           Skip post-seed verification",
      "  --force               Bypass seeder run lock (TTL guard)",
      "  --max-pages <n>        Max pages to scan when discovering existing issues (default: 3)",
      "",
      "Notes:",
      "  Requires profile=sandbox and a sandbox repo allowlist/prefix.",
    ].join("\n")
  );
}

function parseSeedArgs(args: string[]): SeedArgs {
  let repo = "";
  let manifestPath = DEFAULT_MANIFEST;
  let outputPath = DEFAULT_OUTPUT;
  let dryRun = false;
  let json = false;
  let verify = true;
  let force = false;
  let maxScanPages = 3;

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg === "--repo") {
      repo = args[idx + 1] ?? "";
      idx += 1;
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = args[idx + 1] ?? "";
      idx += 1;
      continue;
    }
    if (arg === "--out") {
      outputPath = args[idx + 1] ?? "";
      idx += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--no-verify") {
      verify = false;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--max-pages") {
      const raw = args[idx + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) maxScanPages = parsed;
      idx += 1;
      continue;
    }
  }

  if (!repo.trim()) {
    throw new Error("Missing required --repo <owner/repo> argument.");
  }

  return {
    repo: repo.trim(),
    manifestPath: resolve(manifestPath),
    outputPath: resolve(outputPath),
    dryRun,
    json,
    verify,
    force,
    maxScanPages,
  };
}

export async function runSandboxSeedCommand(args: string[]): Promise<void> {
  const hasHelpFlag = args.includes("-h") || args.includes("--help");
  if (hasHelpFlag) {
    printSandboxSeedHelp();
    process.exit(0);
  }

  const parsed = parseSeedArgs(args);
  await runSeedSuite(parsed);
}
