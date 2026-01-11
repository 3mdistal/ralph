import { $ } from "bun";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadConfig } from "./config";

type BwrbCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type BwrbProcess = {
  cwd: (path: string) => BwrbProcess;
  quiet: () => Promise<BwrbCommandResult>;
};

type BwrbRunner = (strings: TemplateStringsArray, ...values: unknown[]) => BwrbProcess;

const DEFAULT_BWRB_RUNNER: BwrbRunner = $ as unknown as BwrbRunner;

let bwrb: BwrbRunner = DEFAULT_BWRB_RUNNER;

export function __setBwrbRunnerForTests(runner: BwrbRunner): void {
  bwrb = runner;
}

export function __resetBwrbRunnerForTests(): void {
  bwrb = DEFAULT_BWRB_RUNNER;
}

export interface AgentEscalationNote {
  _path: string;
  _name: string;
  type: "agent-escalation";
  "creation-date"?: string;
  status: string;
  repo?: string;
  issue?: string;
  "task-path"?: string;
  "session-id"?: string;
  "resume-status"?: string;
  "resume-attempted-at"?: string;
  "resume-deferred-at"?: string;
  "resume-error"?: string;
}

export async function getEscalationsByStatus(status: string): Promise<AgentEscalationNote[]> {
  const config = loadConfig();

  try {
    const result = await bwrb`bwrb list agent-escalation --where "status == '${status}'" --output json`
      .cwd(config.bwrbVault)
      .quiet();
    return JSON.parse(result.stdout.toString());
  } catch (e) {
    console.error(`[ralph:escalations] Failed to list agent-escalation notes (status=${status}):`, e);
    return [];
  }
}

export async function editEscalation(
  escalationPath: string,
  fields: Record<string, string>
): Promise<boolean> {
  const config = loadConfig();
  const json = JSON.stringify(fields);

  try {
    await bwrb`bwrb edit --path ${escalationPath} --json ${json}`.cwd(config.bwrbVault).quiet();
    return true;
  } catch (e) {
    console.error(`[ralph:escalations] Failed to edit escalation ${escalationPath}:`, e);
    return false;
  }
}

export function extractResolutionSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);

  const headerRe = /^##\s+resolution\s*$/i;
  const nextHeaderRe = /^##\s+\S/;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i] ?? "")) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return null;

  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (nextHeaderRe.test(line)) break;
    collected.push(line);
  }

  const cleaned = collected
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      // Ignore HTML comments used as placeholders.
      if (t.startsWith("<!--") && t.endsWith("-->") && t.length <= 400) return false;
      return true;
    })
    .join("\n")
    .trim();

  return cleaned ? cleaned : null;
}

export async function readResolutionMessage(notePath: string): Promise<string | null> {
  const vault = loadConfig().bwrbVault;
  const abs = join(vault, notePath);

  try {
    const md = await readFile(abs, "utf8");
    return extractResolutionSection(md);
  } catch (e: any) {
    console.warn(`[ralph:escalations] Failed to read escalation note ${notePath}: ${e?.message ?? String(e)}`);
    return null;
  }
}
