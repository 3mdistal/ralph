import { $ as bunDollar } from "bun";

import { getProfile, getSandboxProfileConfig } from "../config";
import { resolveGhTokenEnv } from "../github-app-auth";
import { SandboxTripwireError, assertSandboxWriteAllowed } from "./sandbox-tripwire";

type GhCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type GhProcess = {
  cwd: (path: string) => GhProcess;
  quiet: () => Promise<GhCommandResult>;
};

type GhRunner = (strings: TemplateStringsArray, ...values: unknown[]) => GhProcess;

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

function applyGhEnv(token: string | null): () => void {
  if (!token) return () => {};
  const priorGh = process.env.GH_TOKEN;
  const priorGithub = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = token;
  return () => {
    if (priorGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorGh;
    if (priorGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorGithub;
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

function classifyGhCommand(command: string): "read" | "write" | "unknown" {
  const normalized = normalizeWhitespace(command);
  if (!normalized.startsWith("gh ")) return "unknown";

  if (/\bgh\s+pr\s+(create|merge|edit|ready|review|update-branch|close|reopen)\b/i.test(normalized)) return "write";
  if (/\bgh\s+issue\s+(comment|close|reopen|edit|lock|unlock)\b/i.test(normalized)) return "write";
  if (/\bgh\s+repo\s+(create|delete|fork)\b/i.test(normalized)) return "write";

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

export function createGhRunner(params: { repo: string; mode: "read" | "write" }): GhRunner {
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
        const token = await resolveGhTokenEnv();
        return await withGhEnvLock(async () => {
          const restore = applyGhEnv(token);
          try {
            const proc = getDefaultGhRunner()(strings, ...values);
            const configured = cwdPath ? proc.cwd(cwdPath) : proc;
            return await configured.quiet();
          } finally {
            restore();
          }
        });
      },
    };

    return wrapper;
  };
}
