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
  acquireSyncPermit?: (opts?: { signal?: AbortSignal }) => Promise<() => void>;
  state?: {
    hasIssueSnapshot: (repo: string, issue: string) => boolean;
    runInStateTransaction: (run: () => void) => void;
    recordIssueSnapshot: (input: {
      repo: string;
      issue: string;
      title?: string;
      state?: string;
      url?: string;
      githubNodeId?: string;
      githubUpdatedAt?: string;
      at?: string;
    }) => void;
    recordIssueLabelsSnapshot: (input: { repo: string; issue: string; labels: string[]; at?: string }) => void;
    recordRepoGithubIssueSync: (params: {
      repo: string;
      repoPath?: string;
      botBranch?: string;
      lastSyncAt?: string;
    }) => void;
  };
};

export type SyncResult =
  | {
      status: "ok";
      fetched: number;
      stored: number;
      ralphCount: number;
      newLastSyncAt: string | null;
      hadChanges: boolean;
    }
  | {
      status: "error";
      fetched: number;
      stored: number;
      ralphCount: number;
      newLastSyncAt: string | null;
      hadChanges: boolean;
      rateLimitResetMs?: number;
      error: string;
    }
  | {
      status: "aborted";
      fetched: number;
      stored: number;
      ralphCount: number;
      newLastSyncAt: string | null;
      hadChanges: false;
    };
