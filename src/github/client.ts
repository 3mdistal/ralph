import type { LabelSpec } from "../github-labels";

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
  token?: string;
  userAgent?: string;
};

function classifyStatus(status: number): GitHubErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate_limit";
  return "unknown";
}

function safeJsonParse<T>(text: string): T | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export class GitHubClient {
  private readonly repo: string;
  private readonly token: string | null;
  private readonly userAgent: string;

  constructor(repo: string, opts?: ClientOptions) {
    this.repo = repo;
    this.token = opts?.token ?? this.resolveToken();
    this.userAgent = opts?.userAgent ?? "ralph-loop";
  }

  private resolveToken(): string | null {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    return token ?? null;
  }

  private requireToken(): string {
    if (!this.token) {
      throw new Error("Missing GH_TOKEN/GITHUB_TOKEN for GitHub API requests.");
    }
    return this.token;
  }

  private buildHeaders(opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `token ${this.requireToken()}`,
      "User-Agent": this.userAgent,
    };

    if (opts.etag) headers["If-Match"] = opts.etag;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    return headers;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = `https://api.github.com${path.startsWith("/") ? "" : "/"}${path}`;
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: this.buildHeaders(opts),
    };

    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, init);
    if (opts.allowNotFound && res.status === 404) {
      return { data: null, etag: res.headers.get("etag"), status: res.status };
    }

    const text = await res.text();
    if (!res.ok) {
      throw new GitHubApiError({
        message: `GitHub API ${init.method} ${path} failed (HTTP ${res.status}). ${text.slice(0, 400)}`.trim(),
        code: classifyStatus(res.status),
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
}

export function splitRepoFullName(full: string): { owner: string; name: string } {
  const [owner, name] = full.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo name: ${full}`);
  }
  return { owner, name };
}
