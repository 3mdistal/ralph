import { describe, expect, test } from "bun:test";

import { Semaphore } from "../semaphore";

describe("semaphore", () => {
  test("rejects immediately when signal is already aborted", async () => {
    const semaphore = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();

    try {
      await semaphore.acquire({ signal: controller.signal });
      throw new Error("expected acquire to abort");
    } catch (error: any) {
      expect(error?.name).toBe("AbortError");
    }
  });

  test("aborts while waiting without leaking permits", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();

    const acquirePromise = semaphore.acquire({ signal: controller.signal });
    controller.abort();

    try {
      await acquirePromise;
      throw new Error("expected acquire to abort");
    } catch (error: any) {
      expect(error?.name).toBe("AbortError");
    } finally {
      release();
    }

    expect(semaphore.available()).toBe(1);
  });
});
