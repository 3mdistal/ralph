import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import crypto from "crypto";

import { getConfig, getSandboxProfileConfig, getSandboxProvisioningConfig } from "../config";
import { getRalphRunArtifactsDir, getRalphSandboxManifestPath } from "../paths";
import { initStateDb, listRalphRunsTop, type RalphRunSummary } from "../state";
import { buildProvisionPlan } from "../sandbox/provisioning-core";
import { applySeedFromSpec, executeProvisionPlan } from "../sandbox/provisioning-io";
import { getBaselineSeedSpec, loadSeedSpecFromFile } from "../sandbox/seed-spec";
import { writeSandboxManifest } from "../sandbox/manifest";

type SandboxRunFlags = {
  noSeed: boolean;
  noDaemon: boolean;
  detach: boolean;
  json: boolean;
  tail: number;
};

function parseNonNegativeInt(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < 0) return null;
  return floored;
}

function parseFlags(args: string[]): SandboxRunFlags {
  let noSeed = false;
  let noDaemon = false;
  let detach = false;
  let json = false;
  let tail = 20;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (!token) continue;
    if (token === "--no-seed") {
      noSeed = true;
      continue;
    }
    if (token === "--no-daemon") {
      noDaemon = true;
      continue;
    }
    if (token === "--detach") {
      detach = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--tail") {
      const value = args[i + 1] ?? "";
      const parsed = parseNonNegativeInt(value);
      if (parsed === null) {
        throw new Error(`[ralph:sandbox] Invalid --tail value: ${value}`);
      }
      tail = Math.max(1, parsed);
      i += 1;
      continue;
    }
  }

  return { noSeed, noDaemon, detach, json, tail };
}

function buildTraceBundlePointers(runs: RalphRunSummary[]): Array<{
  runId: string;
  repo: string;
  outcome: string | null;
  bundleDir: string;
  bundleManifestPath: string;
  exists: boolean;
}> {
  return runs.map((run) => {
    const bundleDir = join(getRalphRunArtifactsDir(run.runId), "trace-bundle");
    const bundleManifestPath = join(bundleDir, "bundle-manifest.json");
    return {
      runId: run.runId,
      repo: run.repo,
      outcome: run.outcome ?? null,
      bundleDir,
      bundleManifestPath,
      exists: existsSync(bundleManifestPath),
    };
  });
}

async function spawnSandboxDaemon(params: {
  sandboxRunId: string;
  detach: boolean;
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; pid: number } | null> {
  const script = process.argv[1];
  if (!script) {
    throw new Error("[ralph:sandbox] Cannot determine CLI script path for daemon spawn.");
  }

  const env = {
    ...process.env,
    RALPH_PROFILE: "sandbox",
    RALPH_SANDBOX_RUN_ID: params.sandboxRunId,
    RALPH_SANDBOX_TARGET_FROM_MANIFEST: "1",
  };

  const child = spawn(process.execPath, [script, "--profile", "sandbox", "--run-id", params.sandboxRunId], {
    env,
    stdio: "inherit",
    detached: params.detach,
  });

  const pid = child.pid ?? -1;
  if (params.detach) {
    child.unref();
    return null;
  }

  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  const onSigInt = () => forward("SIGINT");
  const onSigTerm = () => forward("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  try {
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; pid: number }>((resolve) => {
      child.once("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        resolve({ exitCode, signal, pid });
      });
    });
    return result;
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}

export async function runSandboxRunCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  const sandbox = getSandboxProfileConfig();
  if (!sandbox) {
    console.error('[ralph:sandbox] sandbox:run requires profile="sandbox" with a sandbox config block.');
    process.exit(1);
    return;
  }

  const config = getConfig();
  const owner = config.owner;
  const ownerAllowed = sandbox.allowedOwners.some((allowed) => allowed.toLowerCase() === owner.toLowerCase());
  if (!ownerAllowed) {
    console.error(`[ralph:sandbox] sandbox:run owner ${owner} is not in sandbox.allowedOwners.`);
    process.exit(1);
    return;
  }

  const provisioning = getSandboxProvisioningConfig();
  if (!provisioning) {
    console.error("[ralph:sandbox] sandbox:run requires sandbox.provisioning config.");
    process.exit(1);
    return;
  }

  const sandboxRunId = `sandbox-${crypto.randomUUID()}`;
  const plan = buildProvisionPlan({
    runId: sandboxRunId,
    owner,
    botBranch: "bot/integration",
    sandbox,
    provisioning: {
      templateRepo: provisioning.templateRepo,
      templateRef: provisioning.templateRef ?? "main",
      repoVisibility: "private",
      settingsPreset: provisioning.settingsPreset ?? "minimal",
      seed: provisioning.seed,
    },
  });

  let manifest = await executeProvisionPlan(plan);
  const manifestPath = getRalphSandboxManifestPath(plan.runId);

  if (!flags.noSeed && plan.seed) {
    const seedSpec = plan.seed.preset === "baseline"
      ? getBaselineSeedSpec()
      : plan.seed.file
        ? await loadSeedSpecFromFile(plan.seed.file)
        : null;

    if (!seedSpec) {
      console.error("[ralph:sandbox] No seed spec resolved; pass --no-seed to skip.");
      process.exit(1);
      return;
    }

    manifest = await applySeedFromSpec({
      repoFullName: plan.repoFullName,
      manifest,
      seedSpec,
      seedConfig: {
        preset: plan.seed.preset,
        file: plan.seed.file,
      },
    });
    await writeSandboxManifest(manifestPath, manifest);
  }

  if (!flags.json) {
    console.log(`[ralph:sandbox] Provisioned ${plan.repoFullName}`);
    console.log(`[ralph:sandbox] Manifest: ${manifestPath}`);
    if (!flags.noSeed) {
      console.log("[ralph:sandbox] Seed: enabled");
    }
  }

  if (flags.noDaemon) {
    const payload = {
      schemaVersion: 1,
      sandboxRunId: plan.runId,
      repoFullName: plan.repoFullName,
      repoUrl: manifest.repo.url,
      manifestPath,
      daemon: { started: false },
    } as const;

    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log("[ralph:sandbox] Daemon: skipped (--no-daemon)");
      console.log(`[ralph:sandbox] Next: ralph --profile sandbox --run-id ${plan.runId}`);
    }
    process.exit(0);
    return;
  }

  const runStartedAtIso = new Date().toISOString();
  const runStartedAtMs = Date.now();

  if (!flags.json) {
    console.log(`[ralph:sandbox] Starting daemon against ${plan.repoFullName} (runId=${plan.runId})`);
    if (flags.detach) {
      console.log("[ralph:sandbox] Daemon: detaching (--detach)");
    } else {
      console.log("[ralph:sandbox] Daemon: running (Ctrl+C to stop)");
    }
  }

  const daemonResult = await spawnSandboxDaemon({ sandboxRunId: plan.runId, detach: flags.detach });
  if (flags.detach) {
    const payload = {
      schemaVersion: 1,
      sandboxRunId: plan.runId,
      repoFullName: plan.repoFullName,
      repoUrl: manifest.repo.url,
      manifestPath,
      daemon: { started: true, detached: true },
    } as const;
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
    }
    process.exit(0);
    return;
  }

  initStateDb();
  const untilIso = new Date().toISOString();
  const allRuns = listRalphRunsTop({
    limit: Math.max(20, flags.tail),
    sinceIso: runStartedAtIso,
    untilIso,
    includeMissing: true,
    sort: "tokens_total",
  });
  const sandboxRuns = allRuns.filter((r) => r.repo === plan.repoFullName);
  const pointers = buildTraceBundlePointers(sandboxRuns).slice(0, flags.tail);

  const payload = {
    schemaVersion: 1,
    sandboxRunId: plan.runId,
    repoFullName: plan.repoFullName,
    repoUrl: manifest.repo.url,
    manifestPath,
    daemon: {
      started: true,
      detached: false,
      pid: daemonResult?.pid ?? null,
      exitCode: daemonResult?.exitCode ?? null,
      signal: daemonResult?.signal ?? null,
      startedAt: new Date(runStartedAtMs).toISOString(),
      stoppedAt: untilIso,
    },
    traceBundles: pointers,
  } as const;

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
    return;
  }

  console.log(
    `[ralph:sandbox] Daemon exited (code=${daemonResult?.exitCode ?? "null"} signal=${daemonResult?.signal ?? "null"})`
  );
  if (pointers.length === 0) {
    console.log("[ralph:sandbox] No runs recorded in this window.");
    console.log(`[ralph:sandbox] Hint: ralph runs top --since 2h --include-missing`);
    process.exit(0);
    return;
  }

  console.log(`[ralph:sandbox] Trace bundles (tail=${Math.min(flags.tail, pointers.length)})`);
  for (const item of pointers) {
    const status = item.exists ? "ok" : "missing";
    console.log(`- runId=${item.runId} outcome=${item.outcome ?? "unknown"} bundle=${status}`);
    console.log(`  ${item.bundleManifestPath}`);
  }

  process.exit(0);
}
