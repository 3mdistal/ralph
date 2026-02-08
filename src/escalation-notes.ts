export type PatchResolutionSectionResult = {
  changed: boolean;
  markdown: string;
  reason: "updated" | "already-filled";
};

function splitNonEmptyLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function extractResolutionSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const headerRe = /^##\s+resolution\s*$/i;
  const nextHeaderRe = /^##\s+\S/;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i] ?? "")) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return null;

  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (nextHeaderRe.test(line)) break;
    collected.push(line);
  }

  const cleaned = collected
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("<!--") && trimmed.endsWith("-->") && trimmed.length <= 400) return false;
      return true;
    })
    .join("\n")
    .trim();

  return cleaned ? cleaned : null;
}

export function patchResolutionSection(markdown: string, resolutionText: string): PatchResolutionSectionResult {
  const nextResolution = splitNonEmptyLines(resolutionText).join("\n").trim();
  if (!nextResolution) {
    return { changed: false, markdown, reason: "already-filled" };
  }

  const existing = extractResolutionSection(markdown);
  if (existing) {
    return { changed: false, markdown, reason: "already-filled" };
  }

  const lines = markdown.split(/\r?\n/);
  const headerRe = /^##\s+resolution\s*$/i;
  const nextHeaderRe = /^##\s+\S/;

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i] ?? "")) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    const insert = ["## Resolution", "", ...nextResolution.split("\n"), ""];
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^##\s+next\s+steps\s*$/i.test(lines[i] ?? "")) {
        insertAt = i;
        break;
      }
    }
    return {
      changed: true,
      markdown: [...lines.slice(0, insertAt), ...insert, ...lines.slice(insertAt)].join("\n"),
      reason: "updated",
    };
  }

  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (nextHeaderRe.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  return {
    changed: true,
    markdown: [
      ...lines.slice(0, headerIdx + 1),
      "",
      ...nextResolution.split("\n"),
      "",
      ...lines.slice(sectionEnd),
    ].join("\n"),
    reason: "updated",
  };
}
