import { createAbortError } from "./abort";

export type ReleaseFn = () => void;

/**
 * Minimal semaphore.
 *
 * - `tryAcquire()` is non-blocking and returns a release function or null.
 * - `acquire()` waits until a permit is available.
 */
export class Semaphore {
  private inUse = 0;
  private readonly waiters: Array<{
    resolve: (release: ReleaseFn) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`Semaphore capacity must be > 0 (got ${capacity})`);
    }
  }

  available(): number {
    return Math.max(0, this.capacity - this.inUse);
  }

  private releasePermit(): void {
    this.inUse = Math.max(0, this.inUse - 1);

    while (this.inUse < this.capacity && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (!next) return;

      if (next.signal?.aborted) {
        next.onAbort?.();
        continue;
      }

      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }

      this.inUse++;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.releasePermit();
      });
      return;
    }
  }

  async acquire(opts?: { signal?: AbortSignal }): Promise<ReleaseFn> {
    const release = this.tryAcquire();
    if (release) return release;

    const signal = opts?.signal;
    if (signal?.aborted) {
      throw createAbortError("Semaphore acquire aborted");
    }

    return await new Promise<ReleaseFn>((resolve, reject) => {
      const entry = {
        resolve,
        reject: (error: Error) => reject(error),
        signal,
        onAbort: undefined as (() => void) | undefined,
      };

      if (signal) {
        entry.onAbort = () => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(createAbortError("Semaphore acquire aborted"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      this.waiters.push(entry);
    });
  }

  tryAcquire(): ReleaseFn | null {
    if (this.inUse >= this.capacity) return null;
    this.inUse++;

    let released = false;
    return () => {
      if (released) return;
      released = true;

      this.releasePermit();
    };
  }
}
