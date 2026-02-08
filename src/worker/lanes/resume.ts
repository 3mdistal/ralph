import type { AgentTask } from "../../queue-backend";
import type { AgentRun } from "../repo-worker";

export async function runResumeLane(params: {
  task: AgentTask;
  opts?: { resumeMessage?: string; repoSlot?: number | null };
  run: () => Promise<AgentRun>;
}): Promise<AgentRun> {
  return await params.run();
}
