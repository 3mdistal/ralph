import { closeSync, openSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_PATH = join(tmpdir(), "ralph-global-test.lock");

export async function acquireGlobalTestLock(params?: {
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<() => void> {
  const timeoutMs = params?.timeoutMs ?? 30_000;
  const pollIntervalMs = params?.pollIntervalMs ?? 25;
  const startedAt = Date.now();

  while (true) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      return () => {
        try {
          closeSync(fd);
        } catch {
          // best-effort
        }
        try {
          unlinkSync(LOCK_PATH);
        } catch {
          // best-effort
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for global test lock (${LOCK_PATH}).`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
