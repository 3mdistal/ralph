import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RALPH_WORKFLOW_LABELS } from "../github-labels";

type DocLabelRow = { label: string; meaning: string; color: string };

function normalizeCell(cell: string): string {
  return cell.replace(/`/g, "").trim();
}

function parseLabelTable(markdown: string): DocLabelRow[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => line.includes("| Label |") && line.includes("| Meaning |") && line.includes("| Color |")
  );
  if (headerIndex === -1) {
    throw new Error("Label table header not found in docs/product/github-first-orchestration.md");
  }

  const rows: DocLabelRow[] = [];
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) break;
    const parts = line.split("|").map((part) => normalizeCell(part));
    if (parts.length < 4) continue;
    const label = parts[1] ?? "";
    const meaning = parts[2] ?? "";
    const color = parts[3] ?? "";
    if (!label) continue;
    rows.push({ label, meaning, color });
  }

  return rows;
}

describe("label docs drift guard", () => {
  test("docs label table matches RALPH_WORKFLOW_LABELS", () => {
    const docPath = resolve(process.cwd(), "docs/product/github-first-orchestration.md");
    const contents = readFileSync(docPath, "utf-8");
    const rows = parseLabelTable(contents);
    const rowByLabel = new Map(rows.map((row) => [row.label, row]));

    expect(rowByLabel.size).toBe(RALPH_WORKFLOW_LABELS.length);

    for (const label of RALPH_WORKFLOW_LABELS) {
      const row = rowByLabel.get(label.name);
      expect(row).toBeTruthy();
      if (!row) continue;
      expect(row.meaning).toBe(label.description);
      expect(row.color.toLowerCase()).toBe(label.color.toLowerCase());
    }
  });
});
