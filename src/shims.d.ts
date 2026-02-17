declare module "*?config-precedence" {
  export function __resetConfigForTests(): void;
  export function loadConfig(): any;
}

declare module "*?repo-concurrency" {
  export function __resetConfigForTests(): void;
  export function getRepoConcurrencySlots(repo: string): number;
}

declare module "*?repo-concurrency-max" {
  export function __resetConfigForTests(): void;
  export function getRepoConcurrencySlots(repo: string): number;
}

declare module "*?repo-concurrency-invalid" {
  export function __resetConfigForTests(): void;
  export function getRepoConcurrencySlots(repo: string): number;
}

declare module "*?dashboard-control-plane" {
  export function __resetConfigForTests(): void;
  export function getDashboardControlPlaneConfig(): {
    enabled: boolean;
    host: string;
    port: number;
    token: string | undefined;
    allowRemote: boolean;
    exposeRawOpencodeEvents: boolean;
    replayLastDefault: number;
    replayLastMax: number;
  };
}

declare module "@opencode-ai/sdk" {
  export function createOpencodeClient(options: { baseUrl: string }): unknown;
}
