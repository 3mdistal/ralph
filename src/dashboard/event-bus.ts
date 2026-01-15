import { type RalphEvent } from "./events";

export type RalphEventHandler = (event: RalphEvent) => void;

export class RalphEventBus {
  readonly #subscribers = new Set<RalphEventHandler>();
  readonly #buffer: RalphEvent[];
  #bufferSize: number;
  #nextIdx = 0;
  #count = 0;

  constructor(options?: { bufferSize?: number }) {
    const size = options?.bufferSize ?? 1000;
    this.#bufferSize = Math.max(0, Math.floor(size));
    this.#buffer = this.#bufferSize > 0 ? new Array<RalphEvent>(this.#bufferSize) : [];
  }

  publish(event: RalphEvent): void {
    if (this.#bufferSize > 0) {
      this.#buffer[this.#nextIdx] = event;
      this.#nextIdx = (this.#nextIdx + 1) % this.#bufferSize;
      this.#count = Math.min(this.#bufferSize, this.#count + 1);
    }

    for (const handler of this.#subscribers) {
      try {
        handler(event);
      } catch {
        // best-effort: subscribers must not break the bus
      }
    }
  }

  getRecent(limit: number): RalphEvent[] {
    const n = Math.max(0, Math.floor(limit));
    if (this.#count === 0 || n === 0) return [];

    const take = Math.min(this.#count, n);
    const out: RalphEvent[] = [];

    // Oldest event index in ring.
    const start = (this.#nextIdx - this.#count + this.#bufferSize) % this.#bufferSize;

    for (let i = 0; i < take; i++) {
      const idx = (start + (this.#count - take) + i) % this.#bufferSize;
      const ev = this.#buffer[idx];
      if (ev) out.push(ev);
    }

    return out;
  }

  subscribe(handler: RalphEventHandler, opts?: { replayLast?: number }): () => void {
    const replay = opts?.replayLast ?? 0;
    if (replay > 0) {
      for (const ev of this.getRecent(replay)) {
        try {
          handler(ev);
        } catch {
          // ignore
        }
      }
    }

    this.#subscribers.add(handler);

    return () => {
      this.#subscribers.delete(handler);
    };
  }
}
