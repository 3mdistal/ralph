import { redactSensitiveText } from "../redaction";

export type ArtifactTruncationMode = "head" | "tail";
export type GateArtifactPolicyKind = "command_output" | "failure_excerpt" | "note";

export const ARTIFACT_POLICY_VERSION = 1;
export const MAX_SUMMARY_CHARS = 512;
export const MAX_TEXT_CHARS = 8192;
export const MAX_TEXT_LINES = 200;
export const MAX_LIST_ITEMS = 50;

export function applyTextPolicy(params: {
  value: string;
  truncationMode: ArtifactTruncationMode;
  maxChars: number;
  maxLines?: number;
}): {
  value: string;
  truncated: boolean;
  truncationMode: ArtifactTruncationMode;
  originalChars: number;
  originalLines: number;
} {
  const raw = String(params.value ?? "");
  const originalChars = raw.length;
  const originalLines = raw ? raw.split("\n").length : 0;

  let out = redactSensitiveText(raw);
  let truncated = false;

  if (params.maxLines && params.maxLines > 0) {
    const lines = out.split("\n");
    if (lines.length > params.maxLines) {
      out =
        params.truncationMode === "head"
          ? lines.slice(0, params.maxLines).join("\n")
          : lines.slice(lines.length - params.maxLines).join("\n");
      truncated = true;
    }
  }

  if (params.maxChars > 0 && out.length > params.maxChars) {
    out =
      params.truncationMode === "head" ? out.slice(0, params.maxChars) : out.slice(out.length - params.maxChars);
    truncated = true;
  }

  return {
    value: out,
    truncated,
    truncationMode: params.truncationMode,
    originalChars,
    originalLines,
  };
}

export function applyListPolicy<T>(items: T[] | null | undefined): T[] {
  if (!Array.isArray(items)) return [];
  if (items.length <= MAX_LIST_ITEMS) return items;
  return items.slice(0, MAX_LIST_ITEMS);
}

export function applyGateArtifactPolicy(params: {
  kind: GateArtifactPolicyKind;
  content: string;
}): {
  content: string;
  truncated: boolean;
  truncationMode: ArtifactTruncationMode;
  originalChars: number;
  originalLines: number;
  artifactPolicyVersion: number;
} {
  const policy =
    params.kind === "note"
      ? applyTextPolicy({ value: params.content, truncationMode: "head", maxChars: MAX_SUMMARY_CHARS })
      : applyTextPolicy({
          value: params.content,
          truncationMode: "tail",
          maxChars: MAX_TEXT_CHARS,
          maxLines: MAX_TEXT_LINES,
        });

  return {
    content: policy.value,
    truncated: policy.truncated,
    truncationMode: policy.truncationMode,
    originalChars: policy.originalChars,
    originalLines: policy.originalLines,
    artifactPolicyVersion: ARTIFACT_POLICY_VERSION,
  };
}

export function applyGateFieldPolicy(
  value: string | null | undefined,
  maxChars: number
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return applyTextPolicy({ value: trimmed, truncationMode: "head", maxChars }).value;
}
