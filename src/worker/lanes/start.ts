import type { AgentTask } from "../../queue-backend";
import type { AgentRun } from "../repo-worker";

export async function runStartLane(params: {
  task: AgentTask;
  opts?: { repoSlot?: number | null };
  run: () => Promise<AgentRun>;
}): Promise<AgentRun> {
  return await params.run();
}
