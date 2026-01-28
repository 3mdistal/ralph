export function sanitizeExternalText(input: string): string {
  let out = input.replace(/\x1b\[[0-9;]*m/g, "");
  const patterns: Array<{ re: RegExp; replacement: string }> = [
    { re: /ghp_[A-Za-z0-9]{20,}/g, replacement: "ghp_[REDACTED]" },
    { re: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "github_pat_[REDACTED]" },
    { re: /sk-[A-Za-z0-9]{20,}/g, replacement: "sk-[REDACTED]" },
    { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "xox-[REDACTED]" },
    { re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
    { re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
    { re: /\/home\/[A-Za-z0-9._-]+\//g, replacement: "~/" },
    { re: /\/Users\/[A-Za-z0-9._-]+\//g, replacement: "~/" },
  ];

  for (const { re, replacement } of patterns) {
    out = out.replace(re, replacement);
  }

  return out;
}
