import crypto from "crypto";
import { appendFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { $ } from "bun";
import { getBwrbVaultForStorage, getBwrbVaultIfValid } from "../queue-backend";

type BwrbCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type BwrbProcess = {
  cwd: (path: string) => BwrbProcess;
  quiet: () => Promise<BwrbCommandResult>;
};

type BwrbRunner = (strings: TemplateStringsArray, ...values: unknown[]) => BwrbProcess;

type BwrbNewResult = { success: boolean; path?: string; error?: string };

export type BwrbNoteType = "idea" | "agent-escalation" | "agent-run";

export type BwrbArtifactResult =
  | { ok: true; path?: string }
  | { ok: false; skipped: boolean; error: string };

export type BwrbArtifactsDeps = {
  bwrb?: BwrbRunner;
  appendFile?: typeof appendFile;
  getVaultForStorage?: typeof getBwrbVaultForStorage;
  getVaultIfValid?: typeof getBwrbVaultIfValid;
};

const DEFAULT_BWRB_RUNNER: BwrbRunner = $ as unknown as BwrbRunner;

function normalizeOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    return (value as { toString(): string }).toString();
  }
  return "";
}

function parseBwrbNewResult(text: string): BwrbNewResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as BwrbNewResult;
  } catch {
    return null;
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

async function runBwrbNew(params: {
  type: BwrbNoteType;
  json: string;
  vault: string;
  bwrb: BwrbRunner;
}): Promise<{ output?: BwrbNewResult; error?: string }> {
  try {
    const result = await params.bwrb`bwrb new ${params.type} --json ${params.json}`.cwd(params.vault).quiet();
    const parsed = parseBwrbNewResult(normalizeOutputText(result.stdout));
    if (!parsed) return { error: "Failed to parse bwrb output" };
    return { output: parsed };
  } catch (err: any) {
    const stdout = normalizeOutputText(err?.stdout);
    const parsed = parseBwrbNewResult(stdout);
    if (parsed) return { output: parsed };
    return { error: getErrorMessage(err) };
  }
}

function isDuplicateNameError(output?: BwrbNewResult, error?: string): boolean {
  const message = output?.error ?? error ?? "";
  return message.includes("File already exists");
}

function resolveNotePath(notePath: string, deps: BwrbArtifactsDeps): string | null {
  if (isAbsolute(notePath)) return notePath;
  const vault = (deps.getVaultIfValid ?? getBwrbVaultIfValid)();
  if (!vault) return null;
  return join(vault, notePath);
}

export function buildIdeaPayload(params: {
  name: string;
  creationDate: string;
  scope: string;
}): Record<string, string> {
  return {
    name: params.name,
    "creation-date": params.creationDate,
    scope: params.scope,
  };
}

export function buildEscalationPayload(params: {
  name: string;
  task: string;
  taskPath: string;
  issue: string;
  repo: string;
  sessionId: string;
  escalationType: string;
  status: string;
  creationDate: string;
  scope: string;
}): Record<string, string> {
  return {
    name: params.name,
    task: params.task,
    "task-path": params.taskPath,
    issue: params.issue,
    repo: params.repo,
    "session-id": params.sessionId,
    "escalation-type": params.escalationType,
    status: params.status,
    "creation-date": params.creationDate,
    scope: params.scope,
  };
}

export function buildAgentRunPayload(params: {
  name: string;
  task: string;
  started: string;
  completed: string;
  outcome: string;
  pr: string;
  creationDate: string;
  scope: string;
}): Record<string, string> {
  return {
    name: params.name,
    task: params.task,
    started: params.started,
    completed: params.completed,
    outcome: params.outcome,
    pr: params.pr,
    "creation-date": params.creationDate,
    scope: params.scope,
  };
}

export async function createBwrbNote(params: {
  type: BwrbNoteType;
  action: string;
  payload: Record<string, string>;
  allowDuplicateSuffix?: boolean;
},
deps: BwrbArtifactsDeps = {}): Promise<BwrbArtifactResult> {
  const vault = (deps.getVaultForStorage ?? getBwrbVaultForStorage)(params.action);
  if (!vault) {
    return { ok: false, skipped: true, error: "bwrbVault is missing or invalid" };
  }

  const bwrb = deps.bwrb ?? DEFAULT_BWRB_RUNNER;
  const json = JSON.stringify(params.payload);
  const first = await runBwrbNew({ type: params.type, json, vault, bwrb });

  if (first.output?.success) {
    return { ok: true, path: first.output.path };
  }

  if (params.allowDuplicateSuffix && isDuplicateNameError(first.output, first.error)) {
    const name = params.payload.name;
    if (name && typeof name === "string") {
      const suffix = crypto.randomUUID().slice(0, 8);
      const retryPayload = { ...params.payload, name: `${name} [${suffix}]` };
      const retry = await runBwrbNew({ type: params.type, json: JSON.stringify(retryPayload), vault, bwrb });
      if (retry.output?.success) {
        return { ok: true, path: retry.output.path };
      }
      const retryError = retry.output?.error ?? retry.error ?? "Unknown error";
      return { ok: false, skipped: false, error: retryError };
    }
  }

  const error = first.output?.error ?? first.error ?? "Unknown error";
  return { ok: false, skipped: false, error };
}

export async function appendBwrbNoteBody(params: {
  notePath: string;
  body: string;
},
deps: BwrbArtifactsDeps = {}): Promise<BwrbArtifactResult> {
  if (!params.body.trim()) return { ok: true };

  const resolved = resolveNotePath(params.notePath, deps);
  if (!resolved) {
    return { ok: false, skipped: true, error: "bwrbVault is missing or invalid" };
  }

  const append = deps.appendFile ?? appendFile;
  try {
    await append(resolved, params.body, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, skipped: false, error: getErrorMessage(err) };
  }
}
