export function parseCiFixAttempts(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isActionableCheckFailure(rawState: string): boolean {
  const normalized = rawState.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("action_required")) return false;
  if (normalized.includes("stale")) return false;
  if (normalized.includes("cancel")) return false;
  return true;
}

export function parseGhRunId(detailsUrl: string | null | undefined): string | null {
  if (!detailsUrl) return null;
  const match = detailsUrl.match(/\/actions\/runs\/(\d+)/);
  if (!match) return null;
  return match[1] ?? null;
}

export function extractCommandsFromLog(log: string): string[] {
  const lines = log.split("\n");
  const commands = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bunMatch = trimmed.match(/\b(bun\s+(?:run\s+)?[\w:.-]+(?:\s+[^\s].*)?)$/i);
    if (bunMatch?.[1]) {
      commands.add(bunMatch[1]);
    }
    const npmMatch = trimmed.match(/\b(npm\s+(?:run\s+)?[\w:.-]+(?:\s+[^\s].*)?)$/i);
    if (npmMatch?.[1]) {
      commands.add(npmMatch[1]);
    }
    const pnpmMatch = trimmed.match(/\b(pnpm\s+(?:run\s+)?[\w:.-]+(?:\s+[^\s].*)?)$/i);
    if (pnpmMatch?.[1]) {
      commands.add(pnpmMatch[1]);
    }
  }
  return Array.from(commands).sort();
}

export function clipLogExcerpt(log: string, maxLines = 120): string {
  const lines = log.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return lines.join("\n");
  const head = lines.slice(0, Math.floor(maxLines * 0.6));
  const tail = lines.slice(lines.length - Math.ceil(maxLines * 0.4));
  return [...head, "...", ...tail].join("\n");
}
