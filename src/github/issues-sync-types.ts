export type IssueLabel = { name?: string } | string;

export type IssuePayload = {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  updated_at?: string;
  node_id?: string;
  labels?: IssueLabel[];
  pull_request?: unknown;
};

export type SyncDeps = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getToken?: () => Promise<string | null>;
  now?: () => Date;
};

export type SyncResult = {
  ok: boolean;
  fetched: number;
  stored: number;
  ralphCount: number;
  newLastSyncAt: string | null;
  hadChanges: boolean;
  rateLimitResetMs?: number;
  error?: string;
};
