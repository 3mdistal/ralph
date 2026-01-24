import { readFile as readFileFs } from "fs/promises";
import crypto from "crypto";
import { getConfig, type RalphConfig } from "./config";
import { fetchJson, parseLinkHeader } from "./github/http";

export interface GitHubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  defaultBranch?: string;
}

class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

type GitHubAppConfig = {
  appId: number;
  privateKeyPath: string;
  installationId: number;
};

type GitHubAuthDeps = {
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  createSign: typeof crypto.createSign;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_DEPS: GitHubAuthDeps = {
  readFile: (path, encoding) => readFileFs(path, encoding),
  createSign: crypto.createSign.bind(crypto),
  fetch: (input, init) => fetch(input as any, init as any),
};

let deps: GitHubAuthDeps = { ...DEFAULT_DEPS };

export function __setGitHubAuthDepsForTests(next: Partial<GitHubAuthDeps>): void {
  deps = { ...deps, ...next };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0) return null;
  return n;
}

function getGitHubAppConfig(cfg: RalphConfig): GitHubAppConfig | null {
  const raw = (cfg as any).githubApp;
  if (!raw) return null;

  const appId = asPositiveInt(raw.appId);
  const installationId = asPositiveInt(raw.installationId);
  const privateKeyPath = asNonEmptyString(raw.privateKeyPath);

  if (!appId || !installationId || !privateKeyPath) {
    throw new GitHubAuthError(
      "GitHub App auth is configured but invalid. Expected githubApp: { appId, installationId, privateKeyPath }"
    );
  }

  return { appId, installationId, privateKeyPath };
}

function base64UrlEncode(input: string | Uint8Array): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function mintAppJwt(params: { appId: number; privateKeyPath: string }): Promise<string> {
  const privateKeyPem = await deps.readFile(params.privateKeyPath, "utf8");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 30,
    exp: now + 9 * 60,
    iss: String(params.appId),
  };

  const header = { alg: "RS256", typ: "JWT" };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = deps.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(privateKeyPem);
  const encodedSignature = base64UrlEncode(signature);

  return `${signingInput}.${encodedSignature}`;
}

type InstallationTokenCache = {
  token: string;
  expiresAtMs: number;
};

const EXPIRY_SKEW_MS = 60_000;
let tokenCache: InstallationTokenCache | null = null;
let inFlightToken: Promise<InstallationTokenCache> | null = null;


async function mintInstallationToken(cfg: GitHubAppConfig): Promise<InstallationTokenCache> {
  const jwt = await mintAppJwt({ appId: cfg.appId, privateKeyPath: cfg.privateKeyPath });

  const url = `https://api.github.com/app/installations/${cfg.installationId}/access_tokens`;
  const result = await fetchJson<{ token?: string; expires_at?: string }>(deps.fetch, url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "ralph-loop",
    },
  });

  if (!result.ok) {
    throw new GitHubAuthError(
      `Failed to mint installation token (HTTP ${result.status}). ${result.body ? `Body: ${result.body.slice(0, 400)}` : ""}`.trim()
    );
  }

  const token = typeof result.data?.token === "string" ? result.data.token : "";
  const expiresAt = typeof result.data?.expires_at === "string" ? result.data.expires_at : "";
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;

  if (!token || !Number.isFinite(expiresAtMs)) {
    throw new GitHubAuthError("GitHub installation token response missing token/expires_at");
  }

  return { token, expiresAtMs };
}

export async function getInstallationToken(): Promise<string> {
  const cfg = getConfig();
  const app = getGitHubAppConfig(cfg);
  if (!app) {
    throw new GitHubAuthError("GitHub App auth not configured (missing githubApp in ralph.json)");
  }

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs - EXPIRY_SKEW_MS > now) {
    return tokenCache.token;
  }

  if (!inFlightToken) {
    inFlightToken = mintInstallationToken(app)
      .then((fresh) => {
        tokenCache = fresh;
        return fresh;
      })
      .finally(() => {
        inFlightToken = null;
      });
  }

  const fresh = await inFlightToken;
  return fresh.token;
}

export async function ensureGhTokenEnv(): Promise<void> {
  // Best-effort: if githubApp isn't configured, leave GH_TOKEN as-is.
  const cfg = getConfig();
  const app = getGitHubAppConfig(cfg);
  if (!app) return;

  const token = await getInstallationToken();
  // Memory-only: set env for child gh calls; never write to disk.
  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = token;
}


type RepoPayload = {
  id?: number;
  full_name?: string;
  name?: string;
  owner?: { login?: string } | null;
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
  default_branch?: string;
};

export async function listAccessibleRepos(): Promise<GitHubRepoSummary[]> {
  const token = await getInstallationToken();

  const repos: GitHubRepoSummary[] = [];
  let url: string | null = "https://api.github.com/installation/repositories?per_page=100";

  while (url) {
    const result = await fetchJson<{ repositories?: RepoPayload[] }>(deps.fetch, url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${token}`,
        "User-Agent": "ralph-loop",
      },
    });

    if (!result.ok) {
      throw new GitHubAuthError(
        `Failed to list installation repositories (HTTP ${result.status}). ${result.body ? `Body: ${result.body.slice(0, 400)}` : ""}`.trim()
      );
    }

    const raw = Array.isArray(result.data?.repositories) ? result.data.repositories : [];
    for (const r of raw) {
      const id = typeof r?.id === "number" ? r.id : -1;
      const fullName = typeof r?.full_name === "string" ? r.full_name : "";
      const name = typeof r?.name === "string" ? r.name : "";
      const owner = typeof r?.owner?.login === "string" ? r.owner.login : "";
      if (!fullName || !owner || id <= 0) continue;

      repos.push({
        id,
        name,
        fullName,
        owner,
        private: Boolean(r?.private),
        archived: Boolean(r?.archived),
        fork: Boolean(r?.fork),
        defaultBranch: typeof r?.default_branch === "string" ? r.default_branch : undefined,
      });
    }

    const links = parseLinkHeader(result.headers.get("link"));
    url = links.next ?? null;
  }

  return repos;
}

export function getAllowedOwners(): string[] {
  const cfg = getConfig() as any;
  const raw = cfg.allowedOwners;

  const owners: string[] = Array.isArray(raw)
    ? raw.map((v: any) => String(v ?? "").trim()).filter(Boolean)
    : [];

  if (owners.length > 0) return owners;

  const fallback = typeof cfg.owner === "string" && cfg.owner.trim() ? cfg.owner.trim() : "3mdistal";
  return [fallback];
}

export function isRepoAllowed(repo: string): boolean {
  const allowed = new Set(getAllowedOwners().map((o) => o.toLowerCase()));

  const cfgOwner = getConfig().owner;
  const owner = repo.includes("/") ? repo.split("/")[0] : cfgOwner;

  return allowed.has(String(owner).toLowerCase());
}

export function filterReposToAllowedOwners(repos: GitHubRepoSummary[]): GitHubRepoSummary[] {
  const allowed = new Set(getAllowedOwners().map((o) => o.toLowerCase()));
  return repos.filter((r) => allowed.has(r.owner.toLowerCase()));
}

export function __resetGitHubAuthForTests(): void {
  tokenCache = null;
  inFlightToken = null;
  deps = { ...DEFAULT_DEPS };
}
