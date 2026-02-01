export function createAbortError(message = "The operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (error && typeof error === "object" && "name" in error) {
    if ((error as { name?: string }).name === "AbortError") return true;
  }

  return Boolean(signal?.aborted);
}
