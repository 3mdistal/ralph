import type {
  SandboxProfileConfig,
  SandboxProvisioningConfig,
  SandboxProvisioningSeedConfig,
  SandboxProvisioningSettingsPreset,
} from "../config";
import type { NormalizedSeedSpec } from "./seed-spec";

export type ProvisionPlan = {
  runId: string;
  runIdShort: string;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  templateRepo: string;
  templateRef: string;
  repoVisibility: "private";
  settingsPreset: SandboxProvisioningSettingsPreset;
  botBranch: string;
  seed?: {
    mode: "preset" | "file";
    preset?: "baseline";
    file?: string;
    spec?: NormalizedSeedSpec;
  };
};

function buildRunIdShort(runId: string): string {
  const trimmed = runId.trim();
  if (!trimmed) return "run";
  const normalized = trimmed.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const short = normalized.split("-")[0] || normalized;
  return short.slice(0, 8);
}

function buildSandboxRepoName(prefix: string, runIdShort: string): string {
  const trimmedPrefix = prefix.trim();
  const trimmedRun = runIdShort.trim();
  return `${trimmedPrefix}${trimmedRun}`;
}

export function buildProvisionPlan(params: {
  runId: string;
  owner: string;
  botBranch: string;
  sandbox: SandboxProfileConfig;
  provisioning: SandboxProvisioningConfig & {
    templateRef: string;
    repoVisibility: "private";
    settingsPreset: SandboxProvisioningSettingsPreset;
    seed?: SandboxProvisioningSeedConfig;
  };
  seedSpec?: NormalizedSeedSpec;
}): ProvisionPlan {
  const runIdShort = buildRunIdShort(params.runId);
  const repoName = buildSandboxRepoName(params.sandbox.repoNamePrefix, runIdShort);
  const repoOwner = params.owner;
  const repoFullName = `${repoOwner}/${repoName}`;

  return {
    runId: params.runId,
    runIdShort,
    repoOwner,
    repoName,
    repoFullName,
    templateRepo: params.provisioning.templateRepo,
    templateRef: params.provisioning.templateRef,
    repoVisibility: "private",
    settingsPreset: params.provisioning.settingsPreset,
    botBranch: params.botBranch,
    seed: params.provisioning.seed
      ? {
          mode: "file" in params.provisioning.seed ? "file" : "preset",
          file: "file" in params.provisioning.seed ? params.provisioning.seed.file : undefined,
          preset: "preset" in params.provisioning.seed ? params.provisioning.seed.preset : undefined,
          spec: params.seedSpec,
        }
      : undefined,
  };
}
