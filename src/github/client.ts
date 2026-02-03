import type { ExistingLabelSpec, LabelSpec } from "../github-labels";
import { getProfile, getSandboxProfileConfig } from "../config";
import { resolveGitHubToken } from "../github-auth";
import { invalidateInstallationTokenCache } from "../github-app-auth";
import { publishDashboardEvent } from "../dashboard/publisher";
import { Semaphore, type ReleaseFn } from "../semaphore";
import { SandboxTripwireError, assertSandboxWriteAllowed } from "./sandbox-tripwire";

export type GitHubErrorCode = "rate_limit" | "not_found" | "conflict" | "auth" | "unknown";

export class GitHubApiError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number;
  readonly requestId: string | null;
  readonly responseText: string;
  readonly resumeAtTs: number | null;

  constructor(params: {
    message: string;
    code: GitHubErrorCode;
    status: number;
    requestId: string | null;
    responseText: string;
    resumeAtTs?: number | null;
  }) {
    super(params.message);
    this.name = "GitHubApiError";
    this.code = params.code;
    this.status = params.status;
    this.requestId = params.requestId;
    this.responseText = params.responseText;
    this.resumeAtTs = typeof params.resumeAtTs === "number" && Number.isFinite(params.resumeAtTs) ? params.resumeAtTs : null;
  }
}

export type GitHubResponse<T> = {
  data: T | null;
  etag: string | null;
  status: number;
};

export type GitHubResponseMeta<T> = GitHubResponse<T> & {
  link: string | null;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  allowNotFound?: boolean;
  etag?: string;
  /** Optional caller tag for github.request telemetry (e.g. "label-reconciler"). */
  source?: string;
};

type ClientOptions = {
  /** Explicit token override; bypasses refresh (use for non-expiring tokens only). */
  token?: string;
  userAgent?: string;
  getToken?: () => Promise<string | null>;
  /** Injected for tests / custom backoff behavior. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Request timeout for GitHub API fetches (ms). 0 disables. */
  requestTimeoutMs?: number;
};

type GitHubConcurrencyConfig = {
  maxInflight: number;
  maxInflightWrites: number;
};

const DEFAULT_MAX_INFLIGHT = 16;
const DEFAULT_MAX_INFLIGHT_WRITES = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function readEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function parseRateLimitTimestampFromBody(text: string): number | null {
  // Example:
  // "... include the request ID ... and timestamp 2026-01-31 19:34:17 UTC. ..."
  const match = text.match(/\btimestamp\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+UTC\b/i);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}Z`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
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

function parseHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function sanitizeGitHubPath(path: string): string {
  const raw = String(path ?? "");
  if (!raw) return "/";
  try {
    const url = new URL(`https://api.github.com${raw.startsWith("/") ? "" : "/"}${raw}`);
    return url.pathname || "/";
  } catch {
    const trimmed = raw.startsWith("/") ? raw : `/${raw}`;
    return trimmed.split("?")[0].split("#")[0] || "/";
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
  private readonly requestTimeoutMs: number;

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
    this.requestTimeoutMs =
      typeof opts?.requestTimeoutMs === "number" && Number.isFinite(opts.requestTimeoutMs)
        ? Math.max(0, Math.floor(opts.requestTimeoutMs))
        : readEnvInt("RALPH_GITHUB_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
  }

  private getBackoffKeys(tokenKey?: string | null): string[] {
    const keys: string[] = [];
    keys.push(`github:repo:${this.repo}`);
    if (this.installationId) keys.push(`github:installation:${this.installationId}`);
    if (tokenKey) keys.push(`github:token:${tokenKey}`);
    return keys;
  }

  private async waitForBackoffWithInfo(tokenKey?: string | null): Promise<{ waitedMs: number; resumeAtTs: number | null }> {
    let resumeAt = 0;
    for (const key of this.getBackoffKeys(tokenKey)) {
      const until = GitHubClient.backoffUntilByKey.get(key) ?? 0;
      if (until > resumeAt) resumeAt = until;
    }
    const now = Date.now();
    if (resumeAt <= now) return { waitedMs: 0, resumeAtTs: null };
    const delayMs = Math.min(resumeAt - now, 20 * 60_000);
    await this.sleepMsImpl(delayMs);
    return { waitedMs: delayMs, resumeAtTs: resumeAt };
  }

  private shouldEmitRequestTelemetry(params: { ok: boolean; write: boolean; rateLimited: boolean; backoffWaitMs: number }): boolean {
    if (!params.ok) return true;
    if (params.rateLimited) return true;
    if (params.backoffWaitMs > 0) return true;
    if (params.write) return true;

    const rate = clamp01(readEnvFloat("RALPH_GITHUB_REQUEST_TELEMETRY_SAMPLE_RATE", 0.02), 0.02);
    return Math.random() < rate;
  }

  private emitRequestTelemetry(event: {
    method: string;
    path: string;
    status: number;
    ok: boolean;
    write: boolean;
    durationMs: number;
    attempt: number;
    requestId?: string | null;
    allowNotFound?: boolean;
    graphqlOperation?: "query" | "mutation" | null;
    source?: string;
    backoffWaitMs?: number;
    backoffResumeAtTs?: number | null;
    backoffSetUntilTs?: number | null;
    rateLimited?: boolean;
    secondaryRateLimited?: boolean;
    installationId?: string | null;
    retryAfterMs?: number | null;
    willRetry?: boolean;
    rateLimit?: {
      limit?: number | null;
      remaining?: number | null;
      used?: number | null;
      resetAtTs?: number | null;
      resource?: string | null;
    };
    errorCode?: string;
  }): void {
    const status = typeof event.status === "number" ? event.status : 0;
    const rateLimited = Boolean(event.rateLimited);
    const ok = Boolean(event.ok);
    const level = !ok ? (status >= 500 || status === 0 ? "error" : "warn") : rateLimited ? "warn" : "debug";

    try {
      publishDashboardEvent(
        {
          type: "github.request",
          level,
          data: event,
        },
        { repo: this.repo }
      );
    } catch {
      // Best-effort: telemetry must never break request flow.
    }
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

  private async requestInternal<T>(path: string, opts: RequestOptions = {}): Promise<GitHubResponse<T> & { headers: Headers }> {
    const url = `https://api.github.com${path.startsWith("/") ? "" : "/"}${path}`;
    const method = (opts.method ?? "GET").toUpperCase();
    const sanitizedPath = sanitizeGitHubPath(path);
    const graphqlOperation = isGraphqlPath(path) ? getGraphqlOperation(opts.body) : null;
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
    const isWrite = method !== "GET" && method !== "HEAD";
    const semaphores = GitHubClient.resolveSemaphores();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = this.tokenOverride ?? (await this.getToken());
      const tokenKey = token ? fnv1a32(token) : null;
      const backoffInfo = await this.waitForBackoffWithInfo(tokenKey);
      const startedAt = Date.now();

      const init: RequestInit = {
        method,
        headers: this.buildHeaders(opts, token),
      };

      if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
      }

      const controller = this.requestTimeoutMs > 0 ? new AbortController() : null;
      const timeoutId =
        controller && this.requestTimeoutMs > 0
          ? setTimeout(() => {
              controller.abort();
            }, this.requestTimeoutMs)
          : null;
      if (controller) (init as any).signal = controller.signal;

      const releaseRequest: ReleaseFn = await semaphores.request.acquire();
      let releaseWrite: ReleaseFn | null = null;
      if (isWrite) {
        releaseWrite = await semaphores.write.acquire();
      }

      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (error: any) {
        const durationMs = Math.max(0, Date.now() - startedAt);
        const aborted = error?.name === "AbortError" || error?.code === "ABORT_ERR";
        const message = aborted
          ? `GitHub API ${method} ${path} timed out after ${this.requestTimeoutMs}ms.`
          : `GitHub API ${method} ${path} request failed. ${error?.message ?? String(error)}`;

        const ok = false;
        const rateLimited = false;
        const shouldEmit = this.shouldEmitRequestTelemetry({ ok, write: isWrite, rateLimited, backoffWaitMs: backoffInfo.waitedMs });
        if (shouldEmit) {
          this.emitRequestTelemetry({
            method,
            path: sanitizedPath,
            status: 0,
            ok,
            write: isWrite,
            durationMs,
            attempt: attempt + 1,
            allowNotFound: Boolean(opts.allowNotFound),
            graphqlOperation,
            source: typeof opts.source === "string" ? opts.source : undefined,
            backoffWaitMs: backoffInfo.waitedMs,
            backoffResumeAtTs: backoffInfo.resumeAtTs,
            errorCode: "network",
          });
        }

        throw new GitHubApiError({
          message,
          code: "unknown",
          status: 0,
          requestId: null,
          responseText: "",
          resumeAtTs: null,
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        releaseWrite?.();
        releaseRequest();
      }

      const durationMs = Math.max(0, Date.now() - startedAt);

      if (opts.allowNotFound && res.status === 404) {
        const ok = true;
        const rateLimited = false;
        const shouldEmit = this.shouldEmitRequestTelemetry({ ok, write: isWrite, rateLimited, backoffWaitMs: backoffInfo.waitedMs });
        if (shouldEmit) {
          this.emitRequestTelemetry({
            method,
            path: sanitizedPath,
            status: res.status,
            ok,
            write: isWrite,
            durationMs,
            attempt: attempt + 1,
            requestId: res.headers.get("x-github-request-id"),
            allowNotFound: true,
            graphqlOperation,
            source: typeof opts.source === "string" ? opts.source : undefined,
            backoffWaitMs: backoffInfo.waitedMs,
            backoffResumeAtTs: backoffInfo.resumeAtTs,
            rateLimit: {
              limit: parseHeaderInt(res.headers, "x-ratelimit-limit"),
              remaining: parseHeaderInt(res.headers, "x-ratelimit-remaining"),
              used: parseHeaderInt(res.headers, "x-ratelimit-used"),
              resetAtTs: parseRateLimitResetMs(res.headers),
              resource: res.headers.get("x-ratelimit-resource"),
            },
          });
        }

        return { data: null, etag: res.headers.get("etag"), status: res.status, headers: res.headers };
      }

      const text = await res.text();

      if (!res.ok) {
        const retryAfterMs = parseRetryAfterMs(res.headers);
        const resetMs = parseRateLimitResetMs(res.headers);
        const remaining = res.headers.get("x-ratelimit-remaining");
        const remainingZero = typeof remaining === "string" && remaining.trim() === "0";
        const secondaryRateLimited = isSecondaryRateLimitText(text);
        const isRateLimited =
          res.status === 429 ||
          retryAfterMs != null ||
          secondaryRateLimited ||
          (res.status === 403 && (isPrimaryRateLimitText(text) || remainingZero));

        if (res.status === 401 && attempt === 0 && !this.tokenOverride && invalidateInstallationTokenCache()) {
          const shouldEmit = this.shouldEmitRequestTelemetry({
            ok: false,
            write: isWrite,
            rateLimited: isRateLimited,
            backoffWaitMs: backoffInfo.waitedMs,
          });
          if (shouldEmit) {
            this.emitRequestTelemetry({
              method,
              path: sanitizedPath,
              status: res.status,
              ok: false,
              write: isWrite,
              durationMs,
              attempt: attempt + 1,
              requestId: res.headers.get("x-github-request-id"),
              allowNotFound: Boolean(opts.allowNotFound),
              graphqlOperation,
              source: typeof opts.source === "string" ? opts.source : undefined,
              backoffWaitMs: backoffInfo.waitedMs,
              backoffResumeAtTs: backoffInfo.resumeAtTs,
              rateLimited: isRateLimited,
              secondaryRateLimited,
              retryAfterMs,
              rateLimit: {
                limit: parseHeaderInt(res.headers, "x-ratelimit-limit"),
                remaining: parseHeaderInt(res.headers, "x-ratelimit-remaining"),
                used: parseHeaderInt(res.headers, "x-ratelimit-used"),
                resetAtTs: resetMs,
                resource: res.headers.get("x-ratelimit-resource"),
              },
              errorCode: "auth",
              willRetry: true,
            });
          }
          continue;
        }

        const baseCode = classifyStatus(res.status);
        const code: GitHubErrorCode = isRateLimited ? "rate_limit" : baseCode;

        let untilTs: number | null = null;
        if (isRateLimited) {
          const now = Date.now();
          const timestampMs = parseRateLimitTimestampFromBody(text);
          untilTs =
            retryAfterMs != null
              ? now + retryAfterMs
              : resetMs != null
                ? resetMs
                : timestampMs != null && timestampMs > now
                  ? timestampMs
                  : now + 60_000;
          this.recordBackoff({ untilTs, installationId: extractInstallationId(text), tokenKey });
        }

        const installId = extractInstallationId(text);
        if (installId) this.installationId = installId;

        const shouldEmit = this.shouldEmitRequestTelemetry({
          ok: false,
          write: isWrite,
          rateLimited: isRateLimited,
          backoffWaitMs: backoffInfo.waitedMs,
        });
        if (shouldEmit) {
          this.emitRequestTelemetry({
            method,
            path: sanitizedPath,
            status: res.status,
            ok: false,
            write: isWrite,
            durationMs,
            attempt: attempt + 1,
            requestId: res.headers.get("x-github-request-id"),
            allowNotFound: Boolean(opts.allowNotFound),
            graphqlOperation,
            source: typeof opts.source === "string" ? opts.source : undefined,
            backoffWaitMs: backoffInfo.waitedMs,
            backoffResumeAtTs: backoffInfo.resumeAtTs,
            backoffSetUntilTs: untilTs,
            rateLimited: isRateLimited,
            secondaryRateLimited,
            installationId: installId ?? this.installationId,
            retryAfterMs,
            rateLimit: {
              limit: parseHeaderInt(res.headers, "x-ratelimit-limit"),
              remaining: parseHeaderInt(res.headers, "x-ratelimit-remaining"),
              used: parseHeaderInt(res.headers, "x-ratelimit-used"),
              resetAtTs: resetMs,
              resource: res.headers.get("x-ratelimit-resource"),
            },
            errorCode: code,
          });
        }

        const resumeAt = untilTs != null && untilTs > Date.now() ? ` resumeAt=${new Date(untilTs).toISOString()}` : "";

        const missingTokenHint =
          code === "auth" && !token ? "Missing GH_TOKEN/GITHUB_TOKEN for GitHub API requests. " : "";

        throw new GitHubApiError({
          message: `${missingTokenHint}GitHub API ${method} ${path} failed (HTTP ${res.status}). ${text.slice(0, 400)}${resumeAt}`.trim(),
          code,
          status: res.status,
          requestId: res.headers.get("x-github-request-id"),
          responseText: text,
          resumeAtTs: untilTs,
        });
      }

      {
        const ok = true;
        const rateLimited = false;
        const shouldEmit = this.shouldEmitRequestTelemetry({ ok, write: isWrite, rateLimited, backoffWaitMs: backoffInfo.waitedMs });
        if (shouldEmit) {
          this.emitRequestTelemetry({
            method,
            path: sanitizedPath,
            status: res.status,
            ok,
            write: isWrite,
            durationMs,
            attempt: attempt + 1,
            requestId: res.headers.get("x-github-request-id"),
            allowNotFound: Boolean(opts.allowNotFound),
            graphqlOperation,
            source: typeof opts.source === "string" ? opts.source : undefined,
            backoffWaitMs: backoffInfo.waitedMs,
            backoffResumeAtTs: backoffInfo.resumeAtTs,
            rateLimit: {
              limit: parseHeaderInt(res.headers, "x-ratelimit-limit"),
              remaining: parseHeaderInt(res.headers, "x-ratelimit-remaining"),
              used: parseHeaderInt(res.headers, "x-ratelimit-used"),
              resetAtTs: parseRateLimitResetMs(res.headers),
              resource: res.headers.get("x-ratelimit-resource"),
            },
          });
        }
      }

      return {
        data: safeJsonParse<T>(text),
        etag: res.headers.get("etag"),
        status: res.status,
        headers: res.headers,
      };
    }

    throw new GitHubApiError({
      message: `GitHub API ${method} ${path} failed after retries.`,
      code: "unknown",
      status: 0,
      requestId: null,
      responseText: "",
    });
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const response = await this.requestInternal<T>(path, opts);
    return { data: response.data, etag: response.etag, status: response.status };
  }

  async requestWithMeta<T>(path: string, opts: RequestOptions = {}): Promise<GitHubResponseMeta<T>> {
    const response = await this.requestInternal<T>(path, opts);
    return { data: response.data, etag: response.etag, status: response.status, link: response.headers.get("link") };
  }

  async getIssue(issueNumber: number): Promise<unknown> {
    const { owner, name } = splitRepoFullName(this.repo);
    const response = await this.request(`/repos/${owner}/${name}/issues/${issueNumber}`);
    return response.data;
  }

  async listIssueComments(issueNumber: number, opts?: { maxPages?: number; perPage?: number }): Promise<unknown[]> {
    const { owner, name } = splitRepoFullName(this.repo);
    const results: unknown[] = [];
    const maxPages = Math.max(1, Math.min(10, Math.floor(opts?.maxPages ?? 3)));
    const perPage = Math.max(1, Math.min(100, Math.floor(opts?.perPage ?? 100)));
    let page = 1;
    while (page <= maxPages) {
      const response = await this.request<unknown[]>(
        `/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`
      );
      const comments = Array.isArray(response.data) ? response.data : [];
      results.push(...comments);
      if (comments.length < perPage) break;
      page += 1;
    }
    return results;
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
