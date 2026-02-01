export type JsonMarkerParseResult<T> =
  | { ok: true; value: T; markerLine: string; raw: unknown }
  | { ok: false; error: string };

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
