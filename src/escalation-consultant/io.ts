import { appendFile, readFile, unlink, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { initStateDb, hasIdempotencyKey, recordIdempotencyKey } from "../state";
import { runAgent, type RunSessionOptionsBase, type SessionResult } from "../session";
import {
  CONSULTANT_MARKER,
  CONSULTANT_SCHEMA_VERSION,
  buildConsultantPrompt,
  buildFallbackPacket,
  parseConsultantResponse,
  renderConsultantPacket,
  type ParsedConsultantResponse,
  type EscalationConsultantInput,
} from "./core";

type ConsultantAppendResult =
  | { status: "skipped"; reason: string }
  | { status: "appended"; reason?: string }
  | { status: "failed"; reason: string };

type ConsultantAppendDeps = {
  runAgent?: typeof runAgent;
  repoPath?: string;
  log?: (message: string) => void;
};

const LOCK_SUFFIX = ".consultant.lock";

function logMessage(log: ((message: string) => void) | undefined, message: string): void {
  if (log) log(message);
}

function buildIdempotencyKey(notePath: string): string {
  const hash = createHash("sha1").update(notePath).digest("hex").slice(0, 16);
  return `escalation-consultant:v${CONSULTANT_SCHEMA_VERSION}:${hash}`;
}

async function acquireLock(notePath: string): Promise<string | null> {
  const lockPath = notePath + LOCK_SUFFIX;
  try {
    await writeFile(lockPath, String(Date.now()), { flag: "wx" });
    return lockPath;
  } catch {
    return null;
  }
}

async function releaseLock(lockPath: string | null): Promise<void> {
  if (!lockPath) return;
  try {
    await unlink(lockPath);
  } catch {
    // ignore
  }
}

function hasConsultantMarker(text: string): boolean {
  const markerRe = /<!--\s*ralph-consultant:v\d+\s*-->/i;
  return markerRe.test(text) || text.includes("## Consultant Decision (machine)");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
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

export async function appendConsultantPacket(
  notePath: string,
  input: EscalationConsultantInput,
  deps: ConsultantAppendDeps = {}
): Promise<ConsultantAppendResult> {
  initStateDb();
  const idempotencyKey = buildIdempotencyKey(notePath);
  if (hasIdempotencyKey(idempotencyKey)) {
    return { status: "skipped", reason: "idempotent" };
  }

  const lock = await acquireLock(notePath);
  if (!lock) return { status: "skipped", reason: "locked" };

  try {
    const existing = await readFile(notePath, "utf8");
    if (hasConsultantMarker(existing)) {
      return { status: "skipped", reason: "marker-present" };
    }

    const repoPath = deps.repoPath ?? ".";
    const result = await runConsultantAgent(repoPath, input, deps);
    const parsed = result.success ? parseConsultantResponse(result.output) : null;
    const packet = parsed ?? buildFallbackPacket(input);
    if (!result.success) {
      logMessage(deps.log, `[ralph:consultant] consultant run failed; using fallback (${result.errorCode ?? "error"})`);
    }

    const rendered = renderConsultantPacket(packet);
    const prefix = ensureTrailingNewline(existing) + "\n";
    await appendFile(notePath, prefix + rendered, "utf8");
    recordIdempotencyKey({
      key: idempotencyKey,
      scope: "escalation-consultant",
      payloadJson: JSON.stringify({ notePath, issue: input.issue, repo: input.repo }),
    });
    return { status: "appended" };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logMessage(deps.log, `[ralph:consultant] failed to append consultant packet: ${message}`);
    return { status: "failed", reason: message };
  } finally {
    await releaseLock(lock);
  }
}

async function readEscalationNote(notePath: string): Promise<string> {
  return readFile(notePath, "utf8");
}
