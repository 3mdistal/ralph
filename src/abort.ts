export class AbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function createAbortError(message?: string): Error {
  return new AbortError(message);
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  return typeof error === "object" && "name" in error && (error as { name?: string }).name === "AbortError";
}
