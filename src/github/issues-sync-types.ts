import type {
  hasIssueSnapshot,
  recordIssueLabelsSnapshot,
  recordIssueSnapshot,
  recordRepoGithubIssueSync,
  runInStateTransaction,
} from "../state";

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
  state?: Partial<SyncStateDeps>;
};

export type SyncStateDeps = {
  runInStateTransaction: typeof runInStateTransaction;
  hasIssueSnapshot: typeof hasIssueSnapshot;
  recordIssueSnapshot: typeof recordIssueSnapshot;
  recordIssueLabelsSnapshot: typeof recordIssueLabelsSnapshot;
  recordRepoGithubIssueSync: typeof recordRepoGithubIssueSync;
};

export type SyncStatus = "ok" | "error" | "rate_limited" | "aborted";

export type SyncResult = {
  status: SyncStatus;
  ok: boolean;
  fetched: number;
  stored: number;
  ralphCount: number;
  newLastSyncAt: string | null;
  hadChanges: boolean;
  progressed: boolean;
  limitHit?: {
    kind: "maxPages" | "maxIssues";
    pagesFetched: number;
    issuesFetched: number;
    maxPages: number;
    maxIssues: number;
  };
  cursorInvalid?: boolean;
  rateLimitResetMs?: number;
  error?: string;
};
