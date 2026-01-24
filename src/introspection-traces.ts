import { existsSync } from "fs";
import { readdir, rm } from "fs/promises";
import { join } from "path";

import { getRalphSessionDir, getSessionEventsPath } from "./paths";
import { isSafeSessionId } from "./session-id";

export async function cleanupSessionArtifacts(sessionId: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) {
    console.warn(`[ralph] Refusing to clean session artifacts for unsafe session id: ${sessionId}`);
    return;
  }

  const sessionDir = getRalphSessionDir(sessionId);
  if (!existsSync(sessionDir)) return;

  const eventsPath = getSessionEventsPath(sessionId);
  const hasEvents = existsSync(eventsPath);

  try {
    if (!hasEvents) {
      await rm(sessionDir, { recursive: true, force: true });
      return;
    }

    const entries = await readdir(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "events.jsonl") continue;
      try {
        await rm(join(sessionDir, entry.name), { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  } catch {
    // ignore cleanup failures
  }
}
