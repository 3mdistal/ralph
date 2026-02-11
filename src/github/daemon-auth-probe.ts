import type { RalphConfig } from "../config";

import { createGhRunner } from "./gh-runner";

type GhCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type GhProcess = {
  cwd: (path: string) => GhProcess;
  quiet: () => Promise<GhCommandResult>;
};

type GhRunner = (strings: TemplateStringsArray, ...values: unknown[]) => GhProcess;

type GhRunnerFactory = (repo: string) => GhRunner;

type DaemonAuthProbe =
  | { kind: "repo"; command: string }
  | { kind: "user"; command: "gh api /user" };

function hasProdGitHubApp(config: RalphConfig): boolean {
  const app = config.githubApp;
  if (!app) return false;
  const keyPath = typeof app.privateKeyPath === "string" ? app.privateKeyPath.trim() : "";
  return keyPath.length > 0;
}

export function resolveDaemonAuthProbe(config: RalphConfig, probeRepo: string): DaemonAuthProbe {
  if (hasProdGitHubApp(config)) {
    return { kind: "repo", command: `gh api repos/${probeRepo}` };
  }
  return { kind: "user", command: "gh api /user" };
}

function formatDaemonGhAuthValidationError(error: any): string {
  const command = String(error?.ghCommand ?? error?.command ?? "").trim();
  const message = String(error?.message ?? "").trim();
  const stderr = typeof error?.stderr?.toString === "function" ? String(error.stderr.toString()).trim() : "";

  return [
    "[ralph] GitHub auth validation failed for gh CLI (daemon mode).",
    command ? `Command: ${command}` : "",
    message ? `Message: ${message}` : "",
    stderr ? `stderr: ${stderr.slice(0, 1600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function validateDaemonGhAuth(params: {
  config: RalphConfig;
  probeRepo: string;
  createRunner?: GhRunnerFactory;
}): Promise<void> {
  const createRunner =
    params.createRunner ??
    ((repo: string) => {
      return createGhRunner({ repo, mode: "read" });
    });
  const probe = resolveDaemonAuthProbe(params.config, params.probeRepo);
  const ghRead = createRunner(params.probeRepo);

  try {
    if (probe.kind === "repo") {
      await ghRead`gh api repos/${params.probeRepo}`.quiet();
      return;
    }
    await ghRead`gh api /user`.quiet();
  } catch (error: any) {
    throw new Error(formatDaemonGhAuthValidationError(error));
  }
}
