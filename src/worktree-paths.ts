import { join } from "path";

import { getRalphWorktreesDir } from "./paths";
import { sanitizeNoteName } from "./util/sanitize-note-name";

export function buildWorktreePath(params: {
  repo: string;
  issueNumber: string;
  taskKey: string;
  repoSlot: number;
}): string {
  const repoKey = sanitizeNoteName(params.repo);
  const taskKey = sanitizeNoteName(params.taskKey);
  const slot = Number.isInteger(params.repoSlot) ? params.repoSlot : 0;
  return join(getRalphWorktreesDir(), repoKey, `slot-${slot}`, params.issueNumber, taskKey);
}
