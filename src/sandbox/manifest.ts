import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

export type SeededIssueRecord = { key: string; number: number; url: string };
export type SeededPullRequestRecord = { key: string; number: number; url: string };
export type ManifestWarningDetail = { step: string; message: string; code?: string };

export type SandboxManifest = {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  templateRepo: string;
  templateRef: string;
  repo: {
    fullName: string;
    url: string;
    visibility: string;
  };
  settingsPreset: "minimal" | "parity";
  defaultBranch: string;
  botBranch: string;
  steps: {
    provisionedAt?: string;
    settingsAppliedAt?: string;
    seedAppliedAt?: string;
  };
  seed?: {
    preset?: "baseline";
    file?: string;
    issues: SeededIssueRecord[];
    pullRequests: SeededPullRequestRecord[];
    warnings?: string[];
    warningsDetailed?: ManifestWarningDetail[];
  };
  warnings?: string[];
  warningsDetailed?: ManifestWarningDetail[];
};

function ensureSchemaVersion(value: any): asserts value is SandboxManifest {
  if (!value || typeof value !== "object") {
    throw new Error("[ralph:sandbox] Invalid manifest: expected object");
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`[ralph:sandbox] Invalid manifest schemaVersion=${JSON.stringify(value.schemaVersion)}`);
  }
}

export async function readSandboxManifest(path: string): Promise<SandboxManifest> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  ensureSchemaVersion(parsed as any);
  return parsed as SandboxManifest;
}

export async function writeSandboxManifest(path: string, manifest: SandboxManifest): Promise<void> {
  ensureSchemaVersion(manifest as any);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmpPath, path);
}
