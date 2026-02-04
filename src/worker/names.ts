export function safeNoteName(name: string): string {
  return String(name)
    .replace(/[\\/]/g, " - ")
    .replace(/[:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
