import type { ExistingLabelSpec, LabelSpec } from "../github-labels";
import { getProfile, getSandboxProfileConfig } from "../config";
import { resolveGitHubToken } from "../github-auth";
import { Semaphore, type ReleaseFn } from "../semaphore";
import { SandboxTripwireError, assertSandboxWriteAllowed } from "./sandbox-tripwire";

export type GitHubErrorCode = "rate_limit" | "not_found" | "conflict" | "auth" | "unknown";

export class GitHubApiError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number;
  readonly requestId: string | null;
  readonly responseText: string;

  constructor(params: {
    message: string;
    code: GitHubErrorCode;
    status: number;
    requestId: string | null;
    responseText: string;
  }) {
    super(params.message);
    this.name = "GitHubApiError";
    this.code = params.code;
    this.status = params.status;
    this.requestId = params.requestId;
    this.responseText = params.responseText;
  }
}

export type GitHubResponse<T> = {
  data: T | null;
  etag: string | null;
  status: number;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  allowNotFound?: boolean;
  etag?: string;
};

type ClientOptions = {
  /** Explicit token override; bypasses refresh (use for non-expiring tokens only). */
  token?: string;
  userAgent?: string;
  getToken?: () => Promise<string | null>;
  /** Injected for tests / custom backoff behavior. */
  sleepMs?: (ms: number) => Promise<void>;
};

type GitHubConcurrencyConfig = {
  maxInflight: number;
  maxInflightWrites: number;
};

const DEFAULT_MAX_INFLIGHT = 16;
const DEFAULT_MAX_INFLIGHT_WRITES = 2;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function clampConcurrency(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function fnv1a32(input: string): string {
  // Non-cryptographic hash; used only for in-memory backoff bucketing.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Unsigned 32-bit hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isGraphqlPath(path: string): boolean {
  return /^\/?graphql(?:\?|$)/.test(path);
}

function getGraphqlOperation(body: unknown): "query" | "mutation" | null {
  if (!body || typeof body !== "object") return null;
  const query = (body as any).query;
  if (typeof query !== "string") return null;
  const trimmed = query
    .replace(/^[\s\uFEFF\u200B]+/g, "")
    .replace(/^#.*$/gm, "")
    .trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("mutation")) return "mutation";
  if (trimmed.startsWith("query")) return "query";
  if (trimmed.startsWith("{")) return "query";
  return null;
}

function classifyStatus(status: number): GitHubErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate_limit";
  return "unknown";
}

function isSecondaryRateLimitText(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("secondary rate limit") || t.includes("abuse detection") || t.includes("temporarily blocked");
}

function isPrimaryRateLimitText(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("api rate limit exceeded") || t.includes("rate limit exceeded");
}

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

function parseRateLimitResetMs(headers: Headers): number | null {
  const raw = headers.get("x-ratelimit-reset");
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

function extractInstallationId(text: string): string | null {
  const match = text.match(/installation\s+id\s+(\d+)/i);
  return match?.[1] ?? null;
}

function safeJsonParse<T>(text: string): T | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isIssueLabelsCollectionPath(path: string): boolean {
  return /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels(?:\?.*)?$/.test(path);
}

export class GitHubClient {
  private readonly repo: string;
  private readonly userAgent: string;
  private readonly tokenOverride: string | null;
  private readonly getToken: () => Promise<string | null>;
  private readonly sleepMsImpl: (ms: number) => Promise<void>;

  private installationId: string | null = null;

  private static readonly backoffUntilByKey = new Map<string, number>();

  private static concurrencyConfig: GitHubConcurrencyConfig | null = null;
  private static requestSemaphore: Semaphore | null = null;
  private static writeSemaphore: Semaphore | null = null;

  private static resolveConcurrencyConfig(): GitHubConcurrencyConfig {
    if (GitHubClient.concurrencyConfig) return GitHubClient.concurrencyConfig;

    const maxInflight = clampConcurrency(readEnvInt("RALPH_GITHUB_MAX_INFLIGHT", DEFAULT_MAX_INFLIGHT), DEFAULT_MAX_INFLIGHT);
    const maxInflightWrites = clampConcurrency(
      readEnvInt("RALPH_GITHUB_MAX_INFLIGHT_WRITES", DEFAULT_MAX_INFLIGHT_WRITES),
      DEFAULT_MAX_INFLIGHT_WRITES
    );

    GitHubClient.concurrencyConfig = {
      maxInflight,
      maxInflightWrites: Math.min(maxInflight, maxInflightWrites),
    };

    return GitHubClient.concurrencyConfig;
  }

  private static resolveSemaphores(): { request: Semaphore; write: Semaphore } {
    if (!GitHubClient.requestSemaphore || !GitHubClient.writeSemaphore) {
      const cfg = GitHubClient.resolveConcurrencyConfig();
      GitHubClient.requestSemaphore = new Semaphore(cfg.maxInflight);
      GitHubClient.writeSemaphore = new Semaphore(cfg.maxInflightWrites);
    }
    return { request: GitHubClient.requestSemaphore, write: GitHubClient.writeSemaphore };
  }

  static __resetForTests(overrides?: Partial<GitHubConcurrencyConfig>): void {
    GitHubClient.backoffUntilByKey.clear();
    GitHubClient.concurrencyConfig = overrides
      ? {
          maxInflight: clampConcurrency(overrides.maxInflight ?? DEFAULT_MAX_INFLIGHT, DEFAULT_MAX_INFLIGHT),
          maxInflightWrites: clampConcurrency(
            overrides.maxInflightWrites ?? DEFAULT_MAX_INFLIGHT_WRITES,
            DEFAULT_MAX_INFLIGHT_WRITES
          ),
        }
      : null;
    if (GitHubClient.concurrencyConfig) {
      GitHubClient.concurrencyConfig.maxInflightWrites = Math.min(
        GitHubClient.concurrencyConfig.maxInflight,
        GitHubClient.concurrencyConfig.maxInflightWrites
      );
    }
    GitHubClient.requestSemaphore = null;
    GitHubClient.writeSemaphore = null;
  }

  constructor(repo: string, opts?: ClientOptions) {
    this.repo = repo;
    this.userAgent = opts?.userAgent ?? "ralph-loop";
    this.tokenOverride = opts?.token ?? null;
    this.getToken = opts?.getToken ?? resolveGitHubToken;
    this.sleepMsImpl =
      opts?.sleepMs ??
      (async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
  }

  private getBackoffKeys(tokenKey?: string | null): string[] {
    const keys: string[] = [];
    keys.push(`github:repo:${this.repo}`);
    if (this.installationId) keys.push(`github:installation:${this.installationId}`);
    if (tokenKey) keys.push(`github:token:${tokenKey}`);
    return keys;
  }

  private async waitForBackoff(tokenKey?: string | null): Promise<void> {
    let resumeAt = 0;
    for (const key of this.getBackoffKeys(tokenKey)) {
      const until = GitHubClient.backoffUntilByKey.get(key) ?? 0;
      if (until > resumeAt) resumeAt = until;
    }
    const now = Date.now();
    if (resumeAt <= now) return;
    const delayMs = Math.min(resumeAt - now, 10 * 60_000);
    await this.sleepMsImpl(delayMs);
  }

  private recordBackoff(params: { untilTs: number; installationId?: string | null; tokenKey?: string | null }): void {
    const until = Math.max(0, Math.floor(params.untilTs));
    if (!Number.isFinite(until) || until <= Date.now()) return;

    const install = params.installationId?.trim() || null;
    if (install) this.installationId = install;

    const keys = new Set<string>();
    keys.add(`github:repo:${this.repo}`);
    if (install) keys.add(`github:installation:${install}`);
    if (params.tokenKey?.trim()) keys.add(`github:token:${params.tokenKey.trim()}`);

    for (const key of keys) {
      const existing = GitHubClient.backoffUntilByKey.get(key) ?? 0;
      if (until > existing) GitHubClient.backoffUntilByKey.set(key, until);
    }
  }

  private buildHeaders(opts: RequestOptions, token: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": this.userAgent,
    };

    if (token) headers.Authorization = `token ${token}`;

    if (opts.etag) headers["If-Match"] = opts.etag;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    return headers;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const token = this.tokenOverride ?? (await this.getToken());
    const tokenKey = token ? fnv1a32(token) : null;
    await this.waitForBackoff(tokenKey);
    const url = `https://api.github.com${path.startsWith("/") ? "" : "/"}${path}`;
    const method = (opts.method ?? "GET").toUpperCase();
    const profile = getProfile();
    if (profile === "sandbox" && method !== "GET" && method !== "HEAD") {
      if (isGraphqlPath(path)) {
        const op = getGraphqlOperation(opts.body);
        if (op === "mutation") {
          const sandbox = getSandboxProfileConfig();
          assertSandboxWriteAllowed({
            profile,
            repo: this.repo,
            allowedOwners: sandbox?.allowedOwners,
            repoNamePrefix: sandbox?.repoNamePrefix,
          });
        } else if (op === "query") {
          // read-only; allowed
        } else {
          throw new SandboxTripwireError({
            repo: this.repo,
            reason: "unknown GraphQL operation",
          });
        }
      } else {
        const sandbox = getSandboxProfileConfig();
        assertSandboxWriteAllowed({
          profile,
          repo: this.repo,
          allowedOwners: sandbox?.allowedOwners,
          repoNamePrefix: sandbox?.repoNamePrefix,
        });
      }
    }
    if (method === "PUT" && isIssueLabelsCollectionPath(path)) {
      throw new Error(`Refusing to replace issue labels via PUT ${path}`);
    }
    const init: RequestInit = {
      method,
      headers: this.buildHeaders(opts, token),
    };

    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const isWrite = method !== "GET" && method !== "HEAD";
    const semaphores = GitHubClient.resolveSemaphores();
    const releaseRequest: ReleaseFn = await semaphores.request.acquire();
    let releaseWrite: ReleaseFn | null = null;
    if (isWrite) {
      releaseWrite = await semaphores.write.acquire();
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } finally {
      releaseWrite?.();
      releaseRequest();
    }
    if (opts.allowNotFound && res.status === 404) {
      return { data: null, etag: res.headers.get("etag"), status: res.status };
    }

    const text = await res.text();
    if (!res.ok) {
      const baseCode = classifyStatus(res.status);
      const retryAfterMs = parseRetryAfterMs(res.headers);
      const resetMs = parseRateLimitResetMs(res.headers);
      const remaining = res.headers.get("x-ratelimit-remaining");
      const remainingZero = typeof remaining === "string" && remaining.trim() === "0";
      const isRateLimited =
        res.status === 429 ||
        retryAfterMs != null ||
        isSecondaryRateLimitText(text) ||
        (res.status === 403 && (isPrimaryRateLimitText(text) || remainingZero));

      const code: GitHubErrorCode = isRateLimited ? "rate_limit" : baseCode;

      let untilTs: number | null = null;
      if (isRateLimited) {
        const now = Date.now();
        untilTs =
          retryAfterMs != null
            ? now + retryAfterMs
            : resetMs != null
              ? resetMs
              : now + 60_000;
        this.recordBackoff({ untilTs, installationId: extractInstallationId(text), tokenKey });
      }

      const resumeAt = untilTs != null && untilTs > Date.now() ? ` resumeAt=${new Date(untilTs).toISOString()}` : "";

      const missingTokenHint =
        code === "auth" && !token ? "Missing GH_TOKEN/GITHUB_TOKEN for GitHub API requests. " : "";

      throw new GitHubApiError({
        message: `${missingTokenHint}GitHub API ${init.method} ${path} failed (HTTP ${res.status}). ${text.slice(0, 400)}${resumeAt}`.trim(),
        code,
        status: res.status,
        requestId: res.headers.get("x-github-request-id"),
        responseText: text,
      });
    }

    return {
      data: safeJsonParse<T>(text),
      etag: res.headers.get("etag"),
      status: res.status,
    };
  }

  async listLabels(): Promise<string[]> {
    const { owner, name } = splitRepoFullName(this.repo);
    const results: string[] = [];
    let page = 1;

    while (page <= 10) {
      const response = await this.request<Array<{ name?: string | null }>>(
        `/repos/${owner}/${name}/labels?per_page=100&page=${page}`
      );
      const labels = response.data ?? [];
      results.push(...labels.map((label) => label?.name ?? "").filter(Boolean));
      if (labels.length < 100) break;
      page += 1;
    }

    return results;
  }

  async listLabelSpecs(): Promise<ExistingLabelSpec[]> {
    const { owner, name } = splitRepoFullName(this.repo);
    const results: ExistingLabelSpec[] = [];
    let page = 1;

    while (page <= 10) {
      const response = await this.request<
        Array<{ name?: string | null; color?: string | null; description?: string | null }>
      >(`/repos/${owner}/${name}/labels?per_page=100&page=${page}`);
      const labels = response.data ?? [];
      results.push(
        ...labels
          .filter((label) => Boolean(label?.name))
          .map((label) => ({
            name: label?.name ?? "",
            color: label?.color ?? null,
            description: label?.description ?? null,
          }))
      );
      if (labels.length < 100) break;
      page += 1;
    }

    return results;
  }

  async createLabel(label: LabelSpec): Promise<void> {
    const { owner, name } = splitRepoFullName(this.repo);
    await this.request(`/repos/${owner}/${name}/labels`, {
      method: "POST",
      body: {
        name: label.name,
        color: label.color,
        description: label.description,
      },
    });
  }

  async updateLabel(labelName: string, patch: { color?: string; description?: string }): Promise<void> {
    const { owner, name } = splitRepoFullName(this.repo);
    const body: { color?: string; description?: string } = {};
    if (patch.color !== undefined) body.color = patch.color;
    if (patch.description !== undefined) body.description = patch.description;
    if (Object.keys(body).length === 0) return;

    await this.request(`/repos/${owner}/${name}/labels/${encodeURIComponent(labelName)}`, {
      method: "PATCH",
      body,
    });
  }
}

export function splitRepoFullName(full: string): { owner: string; name: string } {
  const [owner, name] = full.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo name: ${full}`);
  }
  return { owner, name };
}

export function __resetGitHubClientForTests(overrides?: Partial<{ maxInflight: number; maxInflightWrites: number }>): void {
  GitHubClient.__resetForTests(overrides);
}
