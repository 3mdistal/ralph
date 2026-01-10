export type ReleaseFn = () => void;

/**
 * Minimal non-blocking semaphore.
 *
 * Use `tryAcquire()` to take a permit if available.
 * It returns a release function, or `null` if no permits remain.
 */
export class Semaphore {
  private inUse = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`Semaphore capacity must be > 0 (got ${capacity})`);
    }
  }

  available(): number {
    return Math.max(0, this.capacity - this.inUse);
  }

  tryAcquire(): ReleaseFn | null {
    if (this.inUse >= this.capacity) return null;
    this.inUse++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse = Math.max(0, this.inUse - 1);
    };
  }
}
