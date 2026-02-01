import { GitHubClient, splitRepoFullName } from "./client";
import {
  initStateDb,
  getIdempotencyPayload,
  hasIdempotencyKey,
  recordIdempotencyKey,
  upsertIdempotencyKey,
} from "../state";

export type DxSurveyOwnershipOwner = "target_repo" | "ralph";
export type DxSurveyOwnershipConfidence = "high" | "medium" | "low";
export type DxSurveySeverity = "p0" | "p1" | "p2" | "p3" | "p4" | "p0-critical" | "p1-high" | "p2-medium" | "p3-low" | "p4-backlog";

export type DxSurveyV1 = {
  schema: "ralph.dx_survey.v1";
  overall?: {
    rating?: number;
    highlights?: string[];
    frictions?: string[];
  };
  negativeItems?: Array<{
    title?: string;
    severity?: DxSurveySeverity;
    ownership?: {
      owner?: DxSurveyOwnershipOwner;
      confidence?: DxSurveyOwnershipConfidence;
      rationale?: string;
    };
    body?: string;
    acceptanceCriteria?: string[];
    evidence?: {
      sessionIds?: string[];
      runLogPaths?: string[];
      urls?: string[];
    };
  }>;
  positives?: Array<{ title?: string; details?: string }>;
};

type DxSurveyEvidence = {
  sessionIds?: string[];
  runLogPaths?: string[];
  urls?: string[];
};

export function parseDxSurveyV1FromText(text: string): DxSurveyV1 | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const tryParse = (candidate: string): DxSurveyV1 | null => {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") return null;
      if ((parsed as any).schema !== "ralph.dx_survey.v1") return null;
      return parsed as DxSurveyV1;
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  // Prefer fenced JSON blocks if present.
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i) ?? raw.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed) return parsed;
  }

  // Fallback: attempt to extract a JSON object substring.
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sliced = raw.slice(first, last + 1);
    const parsed = tryParse(sliced);
    if (parsed) return parsed;
  }

  return null;
}

export type DxSurveyWritebackResult = {
  ok: boolean;
  parsed: boolean;
  parent?: { repo: string; number: number; url: string | null };
  childrenCreated: Array<{ repo: string; number: number; url: string | null }>;
  childrenSkipped: number;
  error?: string;
};

type LabelSpec = { name: string; color: string; description: string };

const DX_LABEL_SPECS: readonly LabelSpec[] = [
  { name: "dx", color: "1D76DB", description: "Developer experience" },
  { name: "ralph-feedback", color: "0E8A16", description: "Ralph DX survey feedback (job record)" },
  { name: "ralph-work", color: "5319E7", description: "Work item created from Ralph feedback" },
  { name: "p0-critical", color: "B60205", description: "Priority 0 (critical / blocker)" },
  { name: "p1-high", color: "D93F0B", description: "Priority 1 (high)" },
  { name: "p2-medium", color: "FBCA04", description: "Priority 2 (medium)" },
  { name: "p3-low", color: "0E8A16", description: "Priority 3 (low)" },
  { name: "p4-backlog", color: "C5DEF5", description: "Priority 4 (backlog)" },
] as const;

type EnsureOutcome =
  | { ok: true; created: string[]; updated: string[] }
  | { ok: false; kind: "auth" | "transient"; error: unknown };

function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeLabelColor(color: string): string {
  return color.trim().replace(/^#/, "").toLowerCase();
}

function normalizeLabelDescription(description: string | null | undefined): string {
  return (description ?? "").trim();
}

async function ensureDxFeedbackLabelsOnce(params: { repo: string; github: GitHubClient }): Promise<EnsureOutcome> {
  let existing;
  try {
    existing = await params.github.listLabelSpecs();
  } catch (error) {
    // Treat as auth-ish; callers should proceed without labels.
    return { ok: false, kind: "auth", error };
  }

  const canonicalByName = new Map<string, LabelSpec>();
  for (const spec of DX_LABEL_SPECS) {
    canonicalByName.set(normalizeLabelName(spec.name), spec);
  }

  const existingByName = new Map<string, { name: string; color?: string | null; description?: string | null }>();
  for (const label of existing) {
    const normalized = normalizeLabelName(label.name);
    if (!canonicalByName.has(normalized)) continue;
    const current = existingByName.get(normalized);
    if (!current) {
      existingByName.set(normalized, label);
      continue;
    }
    // Prefer the canonical-cased label when duplicates exist.
    const canonical = canonicalByName.get(normalized)!;
    if (label.name === canonical.name && current.name !== canonical.name) {
      existingByName.set(normalized, label);
    }
  }

  const toCreate: LabelSpec[] = [];
  const toUpdate: Array<{ currentName: string; patch: { color?: string; description?: string } }> = [];
  for (const spec of DX_LABEL_SPECS) {
    const normalized = normalizeLabelName(spec.name);
    const current = existingByName.get(normalized);
    if (!current) {
      toCreate.push(spec);
      continue;
    }
    const patch: { color?: string; description?: string } = {};
    const currentColor = normalizeLabelColor(current.color ?? "");
    const wantColor = normalizeLabelColor(spec.color);
    if (currentColor !== wantColor) patch.color = spec.color;
    const currentDesc = normalizeLabelDescription(current.description);
    const wantDesc = normalizeLabelDescription(spec.description);
    if (currentDesc !== wantDesc) patch.description = spec.description;
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ currentName: current.name, patch });
    }
  }

  const created: string[] = [];
  for (const spec of toCreate) {
    try {
      await params.github.createLabel(spec);
      created.push(spec.name);
    } catch (error: any) {
      // 422 already exists: ignore.
      const responseText = typeof error?.responseText === "string" ? error.responseText : "";
      if (error?.status === 422 && /already exists/i.test(responseText)) continue;
      return { ok: false, kind: "transient", error };
    }
  }

  const updated: string[] = [];
  for (const update of toUpdate) {
    try {
      await params.github.updateLabel(update.currentName, update.patch);
      updated.push(update.currentName);
    } catch (error) {
      return { ok: false, kind: "transient", error };
    }
  }

  return { ok: true, created, updated };
}

function mapSeverityToPriorityLabel(severity: DxSurveySeverity | undefined): string {
  const s = (severity ?? "p2").toString().trim().toLowerCase();
  if (s === "p0" || s === "p0-critical") return "p0-critical";
  if (s === "p1" || s === "p1-high") return "p1-high";
  if (s === "p2" || s === "p2-medium") return "p2-medium";
  if (s === "p3" || s === "p3-low") return "p3-low";
  if (s === "p4" || s === "p4-backlog") return "p4-backlog";
  return "p2-medium";
}

function hash32(value: string): string {
  // Non-cryptographic, stable. Good enough for idempotency keys.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function createIssue(params: {
  github: GitHubClient;
  repo: string;
  title: string;
  body: string;
}): Promise<{ number: number; html_url: string | null }> {
  const { owner, name } = splitRepoFullName(params.repo);
  const response = await params.github.request<{ number?: number | null; html_url?: string | null }>(
    `/repos/${owner}/${name}/issues`,
    {
      method: "POST",
      body: {
        title: params.title,
        body: params.body,
      },
    }
  );

  const number = response.data?.number;
  if (!number || !Number.isFinite(number)) {
    throw new Error(`GitHub issue create did not return a valid number for ${params.repo}`);
  }
  return { number, html_url: response.data?.html_url ?? null };
}

async function addIssueLabelsBestEffort(params: {
  github: GitHubClient;
  repo: string;
  issueNumber: number;
  labels: string[];
}): Promise<void> {
  const labels = params.labels.map((l) => l.trim()).filter(Boolean);
  if (labels.length === 0) return;
  const { owner, name } = splitRepoFullName(params.repo);
  try {
    await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/labels`, {
      method: "POST",
      body: { labels },
    });
  } catch (error: any) {
    // Retry once after ensuring our label set exists.
    const responseText = typeof error?.responseText === "string" ? error.responseText : "";
    const missingLabel = error?.status === 422 && /label[\s\S]*does not exist/i.test(responseText);
    if (!missingLabel) return;
    const ensured = await ensureDxFeedbackLabelsOnce({ repo: params.repo, github: params.github });
    if (!ensured.ok) return;
    try {
      await params.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/labels`, {
        method: "POST",
        body: { labels },
      });
    } catch {
      // best-effort
    }
  }
}

function renderEvidence(evidence: DxSurveyEvidence | undefined): string {
  const sessionIds = Array.isArray(evidence?.sessionIds) ? evidence!.sessionIds!.filter(Boolean) : [];
  const runLogPaths = Array.isArray(evidence?.runLogPaths) ? evidence!.runLogPaths!.filter(Boolean) : [];
  const urls = Array.isArray(evidence?.urls) ? evidence!.urls!.filter(Boolean) : [];
  const lines: string[] = [];
  if (sessionIds.length > 0) {
    lines.push("- Session IDs:", ...sessionIds.map((s: string) => `  - ${s}`));
  }
  if (runLogPaths.length > 0) {
    lines.push("- Run logs:", ...runLogPaths.map((p: string) => `  - ${p}`));
  }
  if (urls.length > 0) {
    lines.push("- URLs:", ...urls.map((u: string) => `  - ${u}`));
  }
  return lines.length > 0 ? lines.join("\n") : "";
}

export async function writeDxSurveyToGitHubIssues(params: {
  github: GitHubClient;
  targetRepo: string;
  ralphRepo: string;
  issueNumber: string;
  taskName: string;
  cacheKey: string;
  prUrl?: string | null;
  sessionId?: string | null;
  surveyOutput: string;
}): Promise<DxSurveyWritebackResult> {
  initStateDb();

  const ralphClient = params.ralphRepo === params.targetRepo ? params.github : new GitHubClient(params.ralphRepo);

  const parsed = parseDxSurveyV1FromText(params.surveyOutput);
  if (!parsed) {
    return { ok: true, parsed: false, childrenCreated: [], childrenSkipped: 0 };
  }

  const now = new Date().toISOString();

  const parentKey = `gh-dx-survey-parent:${params.targetRepo}#${params.issueNumber}:${params.cacheKey}`;
  let parent: { repo: string; number: number; url: string | null } | null = null;

  if (hasIdempotencyKey(parentKey)) {
    const payload = getIdempotencyPayload(parentKey);
    try {
      const data = payload ? JSON.parse(payload) : null;
      if (data && typeof data === "object" && typeof (data as any).number === "number") {
        parent = { repo: params.targetRepo, number: (data as any).number, url: (data as any).url ?? null };
      }
    } catch {
      // ignore
    }
  }

  if (!parent) {
    const claimed = recordIdempotencyKey({ key: parentKey, scope: "gh-dx-survey" });
    if (claimed) {
      const bodyLines: string[] = [];
      bodyLines.push(
        `DX survey record for a completed Ralph job (created ${now}).`,
        "",
        `- Target repo: ${params.targetRepo}`,
        `- Source issue: #${params.issueNumber}`,
        params.prUrl ? `- PR: ${params.prUrl}` : "",
        params.sessionId ? `- Session: ${params.sessionId}` : "",
        `- Cache key: ${params.cacheKey}`,
        "",
        "## Overall",
        "",
        `- Rating: ${typeof parsed.overall?.rating === "number" ? parsed.overall.rating : "?"}`,
        ...(Array.isArray(parsed.overall?.highlights) && parsed.overall!.highlights!.length
          ? ["- Highlights:", ...parsed.overall!.highlights!.map((h) => `  - ${h}`)]
          : []),
        ...(Array.isArray(parsed.overall?.frictions) && parsed.overall!.frictions!.length
          ? ["- Frictions:", ...parsed.overall!.frictions!.map((f) => `  - ${f}`)]
          : []),
        "",
        "## Raw Survey JSON",
        "",
        "```json",
        params.surveyOutput.trim(),
        "```",
        ""
      );

      const created = await createIssue({
        github: params.github,
        repo: params.targetRepo,
        title: `DX feedback (job): #${params.issueNumber} - ${params.taskName}`.slice(0, 240),
        body: bodyLines.filter(Boolean).join("\n"),
      });

      parent = { repo: params.targetRepo, number: created.number, url: created.html_url };
      try {
        upsertIdempotencyKey({
          key: parentKey,
          scope: "gh-dx-survey",
          payloadJson: JSON.stringify({ number: created.number, url: created.html_url ?? null }),
        });
      } catch {
        // best-effort
      }

      await addIssueLabelsBestEffort({
        github: params.github,
        repo: params.targetRepo,
        issueNumber: created.number,
        labels: ["dx", "ralph-feedback"],
      });
    }
  }

  if (!parent) {
    return {
      ok: false,
      parsed: true,
      childrenCreated: [],
      childrenSkipped: 0,
      error: "Failed to create or resolve parent DX feedback issue",
    };
  }

  const items = Array.isArray(parsed.negativeItems) ? parsed.negativeItems : [];
  const childrenCreated: Array<{ repo: string; number: number; url: string | null }> = [];
  let childrenSkipped = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i] ?? {};
    const title = (item.title ?? "").trim();
    if (!title) continue;

    const owner = item.ownership?.owner === "ralph" ? "ralph" : "target_repo";
    const childRepo = owner === "ralph" ? params.ralphRepo : params.targetRepo;
    const priority = mapSeverityToPriorityLabel(item.severity);

    const childKey = `gh-dx-survey-child:${childRepo}:${params.cacheKey}:${hash32(`${owner}:${priority}:${title}`)}`;
    if (hasIdempotencyKey(childKey)) {
      childrenSkipped += 1;
      continue;
    }

    const claimed = recordIdempotencyKey({ key: childKey, scope: "gh-dx-survey" });
    if (!claimed) {
      childrenSkipped += 1;
      continue;
    }

    const bodyParts: string[] = [];
    bodyParts.push(
      `Parent: ${parent.repo}#${parent.number}`,
      "",
      `- Ownership: ${owner} (${item.ownership?.confidence ?? "?"})`,
      item.ownership?.rationale ? `- Rationale: ${item.ownership.rationale}` : "",
      `- Severity: ${priority}`,
      `- Source issue: ${params.targetRepo}#${params.issueNumber}`,
      params.prUrl ? `- PR: ${params.prUrl}` : "",
      params.sessionId ? `- Session: ${params.sessionId}` : "",
      "",
      item.body?.trim() ? item.body.trim() : "",
      "",
      Array.isArray(item.acceptanceCriteria) && item.acceptanceCriteria.length
        ? ["## Acceptance Criteria", "", ...item.acceptanceCriteria.map((ac) => `- ${ac}`)].join("\n")
        : "",
      "",
      item.evidence ? ["## Evidence", "", renderEvidence(item.evidence)].filter(Boolean).join("\n") : "",
      ""
    );

    const created = await createIssue({
      github: owner === "ralph" ? ralphClient : params.github,
      repo: childRepo,
      title: `DX (${priority}): ${title}`.slice(0, 240),
      body: bodyParts.filter(Boolean).join("\n"),
    });

    const childRecord = { repo: childRepo, number: created.number, url: created.html_url };
    childrenCreated.push(childRecord);
    try {
      upsertIdempotencyKey({
        key: childKey,
        scope: "gh-dx-survey",
        payloadJson: JSON.stringify({ number: created.number, url: created.html_url ?? null, repo: childRepo }),
      });
    } catch {
      // best-effort
    }

    const labels = owner === "ralph" ? ["dx", "ralph-work", priority] : ["dx", priority];
    await addIssueLabelsBestEffort({
      github: owner === "ralph" ? ralphClient : params.github,
      repo: childRepo,
      issueNumber: created.number,
      labels,
    });
  }

  return {
    ok: true,
    parsed: true,
    parent,
    childrenCreated,
    childrenSkipped,
  };
}
