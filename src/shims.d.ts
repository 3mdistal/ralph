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
