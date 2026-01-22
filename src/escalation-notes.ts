import { $ } from "bun";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { getBwrbVaultForStorage } from "./queue-backend";

type BwrbCommandResult = { stdout: Uint8Array | string | { toString(): string } };

type BwrbProcess = {
  cwd: (path: string) => BwrbProcess;
  quiet: () => Promise<BwrbCommandResult>;
};

type BwrbRunner = (strings: TemplateStringsArray, ...values: unknown[]) => BwrbProcess;

const DEFAULT_BWRB_RUNNER: BwrbRunner = $ as unknown as BwrbRunner;

const bwrb: BwrbRunner = DEFAULT_BWRB_RUNNER;

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

export type EditEscalationResult =
  | { ok: true }
  | {
      ok: false;
      kind: "vault-missing" | "bwrb-error";
      error: string;
    };

let warnedMissingVault = false;

function resolveBwrbVault(action: string): string | null {
  const vault = getBwrbVaultForStorage(action);
  if (vault && existsSync(vault)) return vault;

  if (!warnedMissingVault) {
    warnedMissingVault = true;
    console.error(
      `[ralph:escalations] bwrbVault is missing or invalid: ${JSON.stringify(vault)}. ` +
        `Set it in ~/.ralph/config.toml or ~/.ralph/config.json (key: bwrbVault).`
    );
  }

  return null;
}

function formatBwrbShellError(e: unknown): string {
  const err = e as any;
  const parts: string[] = [];

  if (err?.message) parts.push(String(err.message));

  const stdout = err?.stdout?.toString?.() ?? err?.stdout;
  const stderr = err?.stderr?.toString?.() ?? err?.stderr;

  if (typeof stdout === "string" && stdout.trim()) parts.push(`stdout: ${stdout.trim()}`);
  if (typeof stderr === "string" && stderr.trim()) parts.push(`stderr: ${stderr.trim()}`);

  return parts.join("\n").trim() || String(e);
}

export async function getEscalationsByStatus(status: string): Promise<AgentEscalationNote[]> {
  const vault = resolveBwrbVault("list escalations");
  if (!vault) return [];

  try {
    const result = await bwrb`bwrb list agent-escalation --where "status == '${status}'" --output json`
      .cwd(vault)
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
): Promise<EditEscalationResult> {
  const vault = resolveBwrbVault("edit escalation");
  if (!vault) {
    return {
      ok: false,
      kind: "vault-missing",
      error: `bwrbVault is missing or invalid`,
    };
  }

  const json = JSON.stringify(fields);

  try {
    await bwrb`bwrb edit --path ${escalationPath} --json ${json}`.cwd(vault).quiet();
    return { ok: true };
  } catch (e) {
    const error = formatBwrbShellError(e);
    const kind = /no notes found in vault/i.test(error) ? "vault-missing" : "bwrb-error";
    return { ok: false, kind, error };
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
  const vault = resolveBwrbVault("read escalation");
  if (!vault) return null;
  const abs = join(vault, notePath);

  try {
    const md = await readFile(abs, "utf8");
    return extractResolutionSection(md);
  } catch (e: any) {
    console.warn(`[ralph:escalations] Failed to read escalation note ${notePath}: ${e?.message ?? String(e)}`);
    return null;
  }
}
