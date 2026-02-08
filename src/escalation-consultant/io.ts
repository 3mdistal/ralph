import { runAgent, type RunSessionOptionsBase, type SessionResult } from "../session";
import {
  buildConsultantPrompt,
  buildFallbackPacket,
  parseConsultantResponse,
  type ParsedConsultantResponse,
  type EscalationConsultantInput,
} from "./core";

type ConsultantAppendDeps = {
  runAgent?: typeof runAgent;
  repoPath?: string;
  log?: (message: string) => void;
};

function logMessage(log: ((message: string) => void) | undefined, message: string): void {
  if (log) log(message);
}

async function runConsultantAgent(
  repoPath: string,
  input: EscalationConsultantInput,
  deps: ConsultantAppendDeps
): Promise<SessionResult> {
  const prompt = buildConsultantPrompt(input);
  const runner = deps.runAgent ?? runAgent;
  const options: RunSessionOptionsBase = {
    repo: input.repo,
    cacheKey: `escalation-consultant:${input.repo}:${input.issue}:${input.escalationType}`,
  };
  return runner(repoPath, "general", prompt, options);
}

export async function generateConsultantPacket(
  input: EscalationConsultantInput,
  deps: ConsultantAppendDeps = {}
): Promise<{ packet: ParsedConsultantResponse; session: SessionResult }> {
  const repoPath = deps.repoPath ?? ".";
  const session = await runConsultantAgent(repoPath, input, deps);
  const parsed = session.success ? parseConsultantResponse(session.output) : null;
  const packet = parsed ?? buildFallbackPacket(input);
  if (!session.success) {
    logMessage(deps.log, `[ralph:consultant] consultant run failed; using fallback (${session.errorCode ?? "error"})`);
  }
  return { packet, session };
}
