import { describe, expect, test } from "bun:test";

import { Semaphore } from "../semaphore";

describe("semaphore cancellation", () => {
  test("already-aborted signal rejects with AbortError", async () => {
    const semaphore = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();

    await expect(semaphore.acquire({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("abort while waiting removes waiter", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();

    const controller = new AbortController();
    const pending = semaphore.acquire({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(semaphore.available()).toBe(0);

    release();
    expect(semaphore.available()).toBe(1);

    const releaseNext = await semaphore.acquire();
    releaseNext();
    expect(semaphore.available()).toBe(1);
  });
});
