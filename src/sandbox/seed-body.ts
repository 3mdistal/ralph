import type { SeedBodySpec } from "./seed-manifest";
import type { IssueRef } from "../github/issue-ref";
import { formatIssueRef } from "../github/issue-ref";

export const MANAGED_BEGIN = "<!-- ralph-seed:begin -->";
export const MANAGED_END = "<!-- ralph-seed:end -->";

export type SeedMarker = {
  marker: string;
  slug: string;
};

export function formatSeedMarker(marker: string, slug: string): string {
  return `<!-- ${marker} slug=${slug} -->`;
}

export function parseSeedMarker(body: string): SeedMarker | null {
  const match = body.match(/<!--\s*(?<marker>[\w.-]+:v\d+)\s+slug=(?<slug>[\w.-]+)\s*-->/);
  if (!match?.groups?.marker || !match?.groups?.slug) return null;
  return { marker: match.groups.marker, slug: match.groups.slug };
}

export function buildManagedBodyLines(params: {
  body?: SeedBodySpec;
  slugToRef: Map<string, IssueRef>;
}): string[] {
  const lines: string[] = [];
  const body = params.body;
  if (!body) return lines;

  if (body.intro) lines.push(body.intro.trim());

  if (body.blockedBy && body.blockedBy.length > 0) {
    lines.push("## Blocked By");
    for (const item of body.blockedBy) {
      const ref = params.slugToRef.get(item.slug);
      const label = ref ? formatIssueRef(ref) : item.slug;
      const checked = item.checked ? "x" : " ";
      const note = item.note ? ` ${item.note.trim()}` : "";
      lines.push(`- [${checked}] ${label}${note}`);
    }
    lines.push("");
  }

  if (body.blocks && body.blocks.length > 0) {
    lines.push("## Blocks");
    for (const item of body.blocks) {
      const ref = params.slugToRef.get(item.slug);
      const label = ref ? formatIssueRef(ref) : item.slug;
      const checked = item.checked ? "x" : " ";
      const note = item.note ? ` ${item.note.trim()}` : "";
      lines.push(`- [${checked}] ${label}${note}`);
    }
    lines.push("");
  }

  if (body.taskList && body.taskList.length > 0) {
    lines.push("## Task List");
    for (const item of body.taskList) {
      const checked = item.checked ? "x" : " ";
      let label = item.text?.trim() ?? "";
      if (!label && item.slug) {
        const ref = params.slugToRef.get(item.slug);
        label = ref ? formatIssueRef(ref) : item.slug;
      }
      if (!label) label = "(missing)";
      lines.push(`- [${checked}] ${label}`);
    }
    lines.push("");
  }

  if (body.implicitBlockedBy) lines.push(body.implicitBlockedBy.trim());
  if (body.footer) lines.push(body.footer.trim());

  return lines.filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""));
}

export function buildManagedRegion(lines: string[]): string {
  const cleanLines = lines.map((line) => line.replace(/\s+$/g, ""));
  if (cleanLines.length === 0) {
    return [MANAGED_BEGIN, MANAGED_END].join("\n");
  }
  return [MANAGED_BEGIN, ...cleanLines, MANAGED_END].join("\n");
}

export function replaceManagedRegion(params: {
  body: string;
  markerLine: string;
  region: string;
}): string {
  const trimmedBody = params.body ?? "";
  const markerLine = params.markerLine;
  const region = params.region;
  const markerRegex = new RegExp(`${escapeRegExp(markerLine)}\\s*`);

  const bodyWithMarker = trimmedBody.includes(markerLine)
    ? trimmedBody
    : [markerLine, trimmedBody].filter(Boolean).join("\n");

  const beginIndex = bodyWithMarker.indexOf(MANAGED_BEGIN);
  const endIndex = bodyWithMarker.indexOf(MANAGED_END);
  if (beginIndex >= 0 && endIndex > beginIndex) {
    const before = bodyWithMarker.slice(0, beginIndex).replace(/\s*$/, "");
    const after = bodyWithMarker.slice(endIndex + MANAGED_END.length).replace(/^\s*/, "");
    return [before, region, after].filter(Boolean).join("\n");
  }

  const cleaned = bodyWithMarker.replace(markerRegex, `${markerLine}\n`);
  return [cleaned.trimEnd(), region].filter(Boolean).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
