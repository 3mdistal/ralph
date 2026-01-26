import { readFile as readFileFs } from "fs/promises";
import crypto from "crypto";
import { getConfig, getProfile, getSandboxProfileConfig, type RalphConfig, type RalphProfile } from "./config";
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

function getGitHubAppConfigFromRaw(raw: any, label: string): GitHubAppConfig | null {
  if (!raw) return null;

  const appId = asPositiveInt(raw.appId);
  const installationId = asPositiveInt(raw.installationId);
  const privateKeyPath = asNonEmptyString(raw.privateKeyPath);

  if (!appId || !installationId || !privateKeyPath) {
    throw new GitHubAuthError(
      `${label} GitHub App auth is configured but invalid. Expected githubApp: { appId, installationId, privateKeyPath }`
    );
  }

  return { appId, installationId, privateKeyPath };
}

function getGitHubAppConfigForProfile(profile: RalphProfile, cfg: RalphConfig): GitHubAppConfig | null {
  if (profile === "sandbox") {
    const sandbox = cfg.sandbox?.githubAuth?.githubApp;
    return getGitHubAppConfigFromRaw(sandbox as any, "Sandbox");
  }
  return getGitHubAppConfigFromRaw((cfg as any).githubApp, "Prod");
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
const tokenCache = new Map<string, InstallationTokenCache>();
const inFlightToken = new Map<string, Promise<InstallationTokenCache>>();

function buildTokenCacheKey(profile: RalphProfile, app: GitHubAppConfig): string {
  return `${profile}:${app.appId}:${app.installationId}:${app.privateKeyPath}`;
}


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

export async function getInstallationToken(profile: RalphProfile = getProfile()): Promise<string> {
  const cfg = getConfig();
  const app = getGitHubAppConfigForProfile(profile, cfg);
  if (!app) {
    const label = profile === "sandbox" ? "sandbox.githubAuth.githubApp" : "githubApp";
    throw new GitHubAuthError(`GitHub App auth not configured (missing ${label} in config)`);
  }

  const cacheKey = buildTokenCacheKey(profile, app);
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > now) {
    return cached.token;
  }

  if (!inFlightToken.has(cacheKey)) {
    const promise = mintInstallationToken(app)
      .then((fresh) => {
        tokenCache.set(cacheKey, fresh);
        return fresh;
      })
      .finally(() => {
        inFlightToken.delete(cacheKey);
      });
    inFlightToken.set(cacheKey, promise);
  }

  const fresh = await inFlightToken.get(cacheKey)!;
  return fresh.token;
}

export async function resolveGhTokenEnv(): Promise<string | null> {
  const profile = getProfile();
  const cfg = getConfig();

  if (profile === "sandbox") {
    const app = getGitHubAppConfigForProfile(profile, cfg);
    if (app) {
      return await getInstallationToken(profile);
    }

    const sandbox = getSandboxProfileConfig();
    const tokenEnvVar = sandbox?.githubAuth?.tokenEnvVar;
    if (tokenEnvVar) {
      const token = process.env[tokenEnvVar];
      if (token && token.trim()) return token.trim();
    }
    return null;
  }

  // Best-effort: if githubApp isn't configured, leave GH_TOKEN as-is.
  const app = getGitHubAppConfigForProfile("prod", cfg);
  if (app) {
    return await getInstallationToken("prod");
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && token.trim()) return token.trim();

  return null;
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
  const profile = getProfile();
  if (profile === "sandbox") {
    const sandbox = getSandboxProfileConfig();
    const sandboxOwners = sandbox?.allowedOwners ?? [];
    if (sandboxOwners.length > 0) return sandboxOwners;
  }

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
  tokenCache.clear();
  inFlightToken.clear();
  deps = { ...DEFAULT_DEPS };
}
