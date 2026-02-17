import { $ as bunDollar } from "bun";

import { mkdirSync } from "fs";

import { getProfile, getSandboxProfileConfig } from "../config";
import { resolveGhTokenEnv } from "../github-app-auth";
import { getRalphGhConfigDir } from "../paths";
import {
  decideGitHubBudget,
  isGitHubBudgetGovernorDryRun,
  observeGitHubRateLimit,
  type GitHubLane,
} from "./budget-governor";
import { SandboxTripwireError, assertSandboxWriteAllowed } from "./sandbox-tripwire";

type GhCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type GhProcess = {
  cwd: (path: string) => GhProcess;
  quiet: () => Promise<GhCommandResult>;
};

type GhRunner = (strings: TemplateStringsArray, ...values: unknown[]) => GhProcess;

export class GhDeferredError extends Error {
  readonly lane: GitHubLane;
  readonly untilTs: number;
  readonly reason: "cooldown" | "lane_budget" | "pressure";

  constructor(params: { lane: GitHubLane; untilTs: number; reason: "cooldown" | "lane_budget" | "pressure"; message: string }) {
    super(params.message);
    this.name = "GhDeferredError";
    this.lane = params.lane;
    this.untilTs = params.untilTs;
    this.reason = params.reason;
  }
}

const installationIdByRepo = new Map<string, string>();

function getDefaultGhRunner(): GhRunner {
  return ((globalThis as any).$ ?? bunDollar) as unknown as GhRunner;
}

let ghEnvLock: Promise<void> = Promise.resolve();

async function withGhEnvLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = ghEnvLock;
  let release: () => void;
  ghEnvLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release!();
  }
}

function ensureGhConfigDirExists(): string {
  const dir = getRalphGhConfigDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

function applyGhEnv(opts: { token: string | null; ghConfigDir: string }): () => void {
  const priorGh = process.env.GH_TOKEN;
  const priorGithub = process.env.GITHUB_TOKEN;
  const priorPrompt = process.env.GH_PROMPT_DISABLED;
  const priorGhConfigDir = process.env.GH_CONFIG_DIR;

  if (typeof opts.token === "string" && opts.token.trim()) {
    process.env.GH_TOKEN = opts.token;
    process.env.GITHUB_TOKEN = opts.token;
  }
  process.env.GH_PROMPT_DISABLED = "1";
  process.env.GH_CONFIG_DIR = opts.ghConfigDir;

  return () => {
    if (priorGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorGh;

    if (priorGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorGithub;

    if (priorPrompt === undefined) delete process.env.GH_PROMPT_DISABLED;
    else process.env.GH_PROMPT_DISABLED = priorPrompt;

    if (priorGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = priorGhConfigDir;
  };
}

function buildCommandString(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += String(values[i] ?? "");
    out += strings[i + 1] ?? "";
  }
  return out.trim();
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function extractGraphqlQuery(command: string): string | null {
  const match = command.match(/-f\s+query=([\s\S]+?)(?=\s+-[fF]\s+|$)/);
  if (match && match[1]) return match[1];
  return null;
}

function classifyGraphqlQuery(query: string | null): "query" | "mutation" | "unknown" {
  if (!query) return "unknown";
  const trimmed = query
    .replace(/^[\s\uFEFF\u200B]+/g, "")
    .replace(/^#.*$/gm, "")
    .trim();
  if (!trimmed) return "unknown";
  if (trimmed.startsWith("mutation")) return "mutation";
  if (trimmed.startsWith("query")) return "query";
  if (trimmed.startsWith("{")) return "query";
  return "unknown";
}

function parseGhApiMethod(command: string): string | null {
  const methodMatch = command.match(/(?:--method|-X)\s+([A-Za-z]+)/);
  if (!methodMatch) return null;
  return methodMatch[1]?.toUpperCase() ?? null;
}

function defaultLaneForGh(params: { lane?: GitHubLane; source?: string; mode: "read" | "write"; command: string }): GitHubLane {
  if (params.lane) return params.lane;
  const source = (params.source ?? "").toLowerCase();
  const command = params.command.toLowerCase();

  if (
    source.includes("merge") ||
    source.includes("required-check") ||
    source.includes("cmd") ||
    command.includes("pulls/") && command.includes("/merge") ||
    command.includes("pr merge")
  ) {
    return "critical";
  }
  if (source.includes("blocked-comment") || source.includes("audit") || source.includes("parity") || source.includes("sweep")) {
    return "best_effort";
  }
  return params.mode === "read" ? "important" : "important";
}

function parseHeaderIntFromText(text: string, name: string): number | null {
  const pattern = new RegExp(`${name}\\s*[:=]\\s*([0-9]{1,12})`, "i");
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function parseRetryAfterMsFromText(text: string): number | null {
  const seconds = parseHeaderIntFromText(text, "retry-after");
  if (!Number.isFinite(seconds) || (seconds ?? 0) <= 0) return null;
  return Math.round((seconds as number) * 1000);
}

function parseRateLimitResetMsFromText(text: string): number | null {
  const seconds = parseHeaderIntFromText(text, "x-ratelimit-reset");
  if (!Number.isFinite(seconds) || (seconds ?? 0) <= 0) return null;
  return Math.round((seconds as number) * 1000);
}

function extractInstallationId(text: string): string | null {
  const match = text.match(/installation\s+id\s+(\d+)/i);
  return match?.[1] ?? null;
}

function isRateLimitedText(text: string): boolean {
  const value = text.toLowerCase();
  return (
    value.includes("api rate limit exceeded") ||
    value.includes("rate limit exceeded") ||
    value.includes("secondary rate limit") ||
    value.includes("abuse detection") ||
    value.includes("http 429") ||
    value.includes("http 403") && value.includes("rate limit")
  );
}

function observeRateLimitFromGhError(params: { repo: string; error: unknown }): void {
  const anyErr = params.error as any;
  const text = [anyErr?.stderr, anyErr?.stdout, anyErr?.message].map((v) => String(v ?? "")).join("\n");
  if (!text.trim() || !isRateLimitedText(text)) return;

  const nowMs = Date.now();
  const retryAfterMs = parseRetryAfterMsFromText(text);
  const resetAtMs = parseRateLimitResetMsFromText(text);
  const untilTs = retryAfterMs != null ? nowMs + retryAfterMs : resetAtMs ?? nowMs + 60_000;
  const installId = extractInstallationId(text) ?? installationIdByRepo.get(params.repo) ?? null;
  if (installId) installationIdByRepo.set(params.repo, installId);
  observeGitHubRateLimit({
    repo: params.repo,
    scopeKey: installId ? `installation:${installId}` : `repo:${params.repo}`,
    nowMs,
    resumeAtTs: untilTs,
    remaining: parseHeaderIntFromText(text, "x-ratelimit-remaining"),
    resetAtTs: resetAtMs,
  });
}

function classifyGhCommand(command: string): "read" | "write" | "unknown" {
  const normalized = normalizeWhitespace(command);
  if (!normalized.startsWith("gh ")) return "unknown";

  if (/\bgh\s+pr\s+(create|merge|edit|ready|review|update-branch|close|reopen)\b/i.test(normalized)) return "write";
  if (/\bgh\s+issue\s+(comment|close|reopen|edit|lock|unlock)\b/i.test(normalized)) return "write";
  if (/\bgh\s+repo\s+(create|delete|fork)\b/i.test(normalized)) return "write";
  if (/\bgh\s+repo\s+clone\b/i.test(normalized)) return "read";

  if (/\bgh\s+pr\s+(list|view|status)\b/i.test(normalized)) return "read";
  if (/\bgh\s+issue\s+view\b/i.test(normalized)) return "read";
  if (/\bgh\s+run\s+view\b/i.test(normalized)) return "read";

  if (/\bgh\s+api\s+graphql\b/i.test(normalized)) {
    const op = classifyGraphqlQuery(extractGraphqlQuery(command));
    if (op === "mutation") return "write";
    if (op === "query") return "read";
    return "unknown";
  }

  if (/\bgh\s+api\b/i.test(normalized)) {
    const method = parseGhApiMethod(normalized);
    if (!method || method === "GET") return "read";
    return "write";
  }

  return "unknown";
}

function assertGhCommandAllowed(params: { repo: string; mode: "read" | "write"; command: string }): void {
  const classification = classifyGhCommand(params.command);

  if (params.mode === "read" && classification === "write") {
    throw new Error(`Refusing to run write gh command with ghRead: ${params.command}`);
  }

  const profile = getProfile();
  if (profile !== "sandbox") return;

  if (classification === "unknown") {
    throw new SandboxTripwireError({ repo: params.repo, reason: "unknown gh command" });
  }

  if (classification === "write") {
    const sandbox = getSandboxProfileConfig();
    assertSandboxWriteAllowed({
      profile,
      repo: params.repo,
      allowedOwners: sandbox?.allowedOwners,
      repoNamePrefix: sandbox?.repoNamePrefix,
    });
  }
}

export function createGhRunner(params: { repo: string; mode: "read" | "write"; lane?: GitHubLane; source?: string }): GhRunner {
  return (strings: TemplateStringsArray, ...values: unknown[]): GhProcess => {
    const command = buildCommandString(strings, values);
    assertGhCommandAllowed({ repo: params.repo, mode: params.mode, command });

    let cwdPath: string | null = null;
    const wrapper: GhProcess = {
      cwd: (path: string) => {
        cwdPath = path;
        return wrapper;
      },
      quiet: async () => {
        const lane = defaultLaneForGh({ lane: params.lane, source: params.source, mode: params.mode, command });
        const scopeInstallId = installationIdByRepo.get(params.repo) ?? null;
        const decision = decideGitHubBudget({
          repo: params.repo,
          scopeKey: scopeInstallId ? `installation:${scopeInstallId}` : `repo:${params.repo}`,
          lane,
          isWrite: params.mode === "write",
          nowMs: Date.now(),
        });
        if (decision.kind === "defer" && !isGitHubBudgetGovernorDryRun()) {
          throw new GhDeferredError({
            lane,
            untilTs: decision.untilTs,
            reason: decision.reason,
            message: `gh command deferred by budget governor (${decision.reason}) until ${new Date(decision.untilTs).toISOString()}`,
          });
        }
        const token = await resolveGhTokenEnv();
        const ghConfigDir = ensureGhConfigDirExists();
        return await withGhEnvLock(async () => {
          const restore = applyGhEnv({ token, ghConfigDir });
          try {
            const proc = getDefaultGhRunner()(strings, ...values);
            const configured = cwdPath ? proc.cwd(cwdPath) : proc;
            try {
              return await configured.quiet();
            } catch (error: any) {
              observeRateLimitFromGhError({ repo: params.repo, error });
              // Attach context for higher-signal diagnostics and classification.
              // Mutate in-place to preserve stack when possible.
              if (error && typeof error === "object") {
                if ((error as any).ghCommand === undefined) (error as any).ghCommand = command;
                if ((error as any).ghRepo === undefined) (error as any).ghRepo = params.repo;
                if ((error as any).ghMode === undefined) (error as any).ghMode = params.mode;
                if ((error as any).ghLane === undefined) (error as any).ghLane = lane;
              }
              throw error;
            }
          } finally {
            restore();
          }
        });
      },
    };

    return wrapper;
  };
}
