const TEST_LOCK_KEY = "__ralphTestLock";

export async function acquireGlobalTestLock(): Promise<() => void> {
  const current = (globalThis as any)[TEST_LOCK_KEY] ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  (globalThis as any)[TEST_LOCK_KEY] = current.then(() => next);
  await current;
  return release!;
}
