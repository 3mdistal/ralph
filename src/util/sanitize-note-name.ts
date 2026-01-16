const MAX_NOTE_NAME_LENGTH = 180;

export function sanitizeNoteName(name: string): string {
  const sanitized = name
    .replace(/[\\/]/g, " - ")
    .replace(/[:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_NAME_LENGTH);

  return sanitized || "Untitled";
}
