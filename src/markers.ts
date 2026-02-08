export type JsonMarkerParseResult<T> =
  | { ok: true; value: T; markerLine: string; raw: unknown }
  | { ok: false; error: string };

export type StrictJsonMarkerParseFailure =
  | "empty_output"
  | "missing_marker"
  | "multiple_markers"
  | "marker_not_final_line"
  | "missing_json"
  | "invalid_json";

export type StrictJsonMarkerParseResult<T> =
  | { ok: true; value: T; markerLine: string; raw: unknown }
  | { ok: false; failure: StrictJsonMarkerParseFailure; error: string };

export function parseLastLineJsonMarker<T>(output: string, prefix: string): JsonMarkerParseResult<T> {
  const text = String(output ?? "");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const markerPrefix = `${prefix}:`;
    if (!trimmed.startsWith(markerPrefix)) {
      return { ok: false, error: `Missing marker '${prefix}:' on last non-empty line` };
    }
    const jsonText = trimmed.slice(markerPrefix.length).trim();
    if (!jsonText) {
      return { ok: false, error: `Missing JSON payload after '${prefix}:'` };
    }
    try {
      const parsed = JSON.parse(jsonText);
      return { ok: true, value: parsed as T, markerLine: trimmed, raw: parsed };
    } catch (error: any) {
      return { ok: false, error: `Invalid JSON after '${prefix}:' (${error?.message ?? String(error)})` };
    }
  }
  return { ok: false, error: "Output was empty" };
}

export function parseStrictFinalLineJsonMarker<T>(output: string, prefix: string): StrictJsonMarkerParseResult<T> {
  const text = String(output ?? "");
  const lines = text.split(/\r?\n/);
  const markerPrefix = `${prefix}:`;
  const markerIndices: number[] = [];
  let lastNonEmptyIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed) lastNonEmptyIndex = i;
    if (lines[i].trimStart().startsWith(markerPrefix)) markerIndices.push(i);
  }

  if (lastNonEmptyIndex < 0) {
    return { ok: false, failure: "empty_output", error: "Output was empty" };
  }

  if (markerIndices.length === 0) {
    return {
      ok: false,
      failure: "missing_marker",
      error: `Missing marker '${markerPrefix}' on final line`,
    };
  }

  if (markerIndices.length > 1) {
    return {
      ok: false,
      failure: "multiple_markers",
      error: `Found multiple '${markerPrefix}' lines`,
    };
  }

  if (markerIndices[0] !== lastNonEmptyIndex) {
    return {
      ok: false,
      failure: "marker_not_final_line",
      error: `Marker '${markerPrefix}' must be on the final non-empty line`,
    };
  }

  const markerLine = lines[lastNonEmptyIndex].trim();
  const jsonText = markerLine.slice(markerPrefix.length).trim();
  if (!jsonText) {
    return {
      ok: false,
      failure: "missing_json",
      error: `Missing JSON payload after '${markerPrefix}'`,
    };
  }

  try {
    const parsed = JSON.parse(jsonText);
    return { ok: true, value: parsed as T, markerLine, raw: parsed };
  } catch (error: any) {
    return {
      ok: false,
      failure: "invalid_json",
      error: `Invalid JSON after '${markerPrefix}' (${error?.message ?? String(error)})`,
    };
  }
}
