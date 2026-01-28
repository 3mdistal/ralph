import { readFile } from "fs/promises";
import { isAbsolute } from "path";

type SeedPreset = "baseline";

type SeedSpecV1 = {
  schemaVersion: 1;
  issues?: SeedIssueSpec[];
  pullRequests?: SeedPullRequestSpec[];
};

export type SeedIssueSpec = {
  key?: string;
  title: string;
  body?: string;
  labels?: string[];
  comments?: Array<{ body: string }>;
};

export type SeedPullRequestSpec = {
  key?: string;
  title: string;
  body?: string;
  base?: string;
  head?: string;
  file?: { path: string; content: string };
  comments?: Array<{ body: string }>;
};

export type NormalizedSeedIssue = Required<Pick<SeedIssueSpec, "title">> & {
  key: string;
  body: string;
  labels: string[];
  comments: Array<{ body: string }>;
};

export type NormalizedSeedPullRequest = Required<Pick<SeedPullRequestSpec, "title">> & {
  key: string;
  body: string;
  base?: string;
  head?: string;
  file?: { path: string; content: string };
  comments: Array<{ body: string }>;
};

export type NormalizedSeedSpec = {
  schemaVersion: 1;
  issues: NormalizedSeedIssue[];
  pullRequests: NormalizedSeedPullRequest[];
};

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = toNonEmptyString(entry);
    if (!trimmed) return null;
    out.push(trimmed);
  }
  return out;
}

function toComments(value: unknown): Array<{ body: string }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: Array<{ body: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const body = toNonEmptyString((entry as any).body);
    if (!body) return null;
    out.push({ body });
  }
  return out;
}

function normalizeKey(key: string | null, fallback: string): string {
  if (!key) return fallback;
  return key.replace(/\s+/g, "-").trim();
}

export function parseSeedSpec(input: unknown, sourceLabel = "seed spec"): NormalizedSeedSpec {
  if (!input || typeof input !== "object") {
    throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: expected an object`);
  }
  const raw = input as any;
  if (raw.schemaVersion !== 1) {
    throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: schemaVersion must be 1`);
  }

  const rawIssues = raw.issues ?? [];
  if (!Array.isArray(rawIssues)) {
    throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: issues must be an array`);
  }

  const issues: NormalizedSeedIssue[] = rawIssues.map((entry: any, index: number) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: issue at index ${index} is not an object`);
    }
    const title = toNonEmptyString(entry.title);
    if (!title) {
      throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: issue at index ${index} missing title`);
    }
    const body = entry.body ? toNonEmptyString(entry.body) : "";
    const labels = toStringArray(entry.labels);
    if (!labels) {
      throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: issue labels at index ${index} must be strings`);
    }
    const comments = toComments(entry.comments);
    if (!comments) {
      throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: issue comments at index ${index} must be objects`);
    }
    const key = normalizeKey(toNonEmptyString(entry.key), `issue-${index + 1}`);
    return { key, title, body: body ?? "", labels, comments };
  });

  const rawPrs = raw.pullRequests ?? [];
  if (!Array.isArray(rawPrs)) {
    throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: pullRequests must be an array`);
  }

  const pullRequests: NormalizedSeedPullRequest[] = rawPrs.map((entry: any, index: number) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: pullRequest at index ${index} is not an object`);
    }
    const title = toNonEmptyString(entry.title);
    if (!title) {
      throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: pullRequest at index ${index} missing title`);
    }
    const body = entry.body ? toNonEmptyString(entry.body) : "";
    const comments = toComments(entry.comments);
    if (!comments) {
      throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: pullRequest comments at index ${index} must be objects`);
    }
    const key = normalizeKey(toNonEmptyString(entry.key), `pr-${index + 1}`);
    const base = toNonEmptyString(entry.base) ?? undefined;
    const head = toNonEmptyString(entry.head) ?? undefined;
    let file: { path: string; content: string } | undefined;
    if (entry.file !== undefined) {
      if (!entry.file || typeof entry.file !== "object") {
        throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: pullRequest file at index ${index} must be object`);
      }
      const path = toNonEmptyString(entry.file.path);
      if (!path) {
        throw new Error(`[ralph:sandbox] Invalid ${sourceLabel}: pullRequest file at index ${index} missing path`);
      }
      const content = toNonEmptyString(entry.file.content) ?? "";
      file = { path, content };
    }

    return { key, title, body: body ?? "", base, head, file, comments };
  });

  return { schemaVersion: 1, issues, pullRequests };
}

export async function loadSeedSpecFromFile(filePath: string): Promise<NormalizedSeedSpec> {
  if (!isAbsolute(filePath)) {
    throw new Error(`[ralph:sandbox] Seed file path must be absolute: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`[ralph:sandbox] Failed to parse seed file ${filePath}: ${e?.message ?? String(e)}`);
  }
  return parseSeedSpec(parsed, `seed file ${filePath}`);
}

export function getBaselineSeedSpec(): NormalizedSeedSpec {
  return parseSeedSpec(
    {
      schemaVersion: 1,
      issues: [
        {
          key: "baseline-issue",
          title: "Sandbox baseline issue",
          body: "This is a seeded issue created for sandbox validation.",
          labels: ["ralph:queued"],
          comments: [{ body: "Seeded issue comment." }],
        },
      ],
      pullRequests: [
        {
          key: "baseline-pr",
          title: "Sandbox baseline PR",
          body: "Seeded PR for sandbox validation.",
          file: { path: "sandbox-baseline.txt", content: "baseline" },
          comments: [{ body: "Seeded PR comment." }],
        },
      ],
    },
    "baseline seed preset"
  );
}
