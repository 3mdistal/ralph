import { homedir } from "os";

export function redactHomePathForDisplay(value: string): string {
  const pathValue = String(value ?? "");
  const home = homedir();
  if (!home) return pathValue;
  return pathValue.split(home).join("~");
}

const SENSITIVE_RULES: Array<{ re: RegExp; replacement: string }> = [
  { re: /ghp_[A-Za-z0-9]{20,}/g, replacement: "ghp_[REDACTED]" },
  { re: /ghs_[A-Za-z0-9]{20,}/g, replacement: "ghs_[REDACTED]" },
  { re: /gho_[A-Za-z0-9]{20,}/g, replacement: "gho_[REDACTED]" },
  { re: /ghu_[A-Za-z0-9]{20,}/g, replacement: "ghu_[REDACTED]" },
  { re: /ghr_[A-Za-z0-9]{20,}/g, replacement: "ghr_[REDACTED]" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "github_pat_[REDACTED]" },
  { re: /sk-[A-Za-z0-9]{20,}/g, replacement: "sk-[REDACTED]" },
  { re: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA[REDACTED]" },
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: "[REDACTED_JWT]" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "xox-[REDACTED]" },
  { re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
  { re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
  {
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  { re: /("access_token"\s*:\s*")([^"]+)(")/gi, replacement: "$1[REDACTED]$3" },
  { re: /("refresh_token"\s*:\s*")([^"]+)(")/gi, replacement: "$1[REDACTED]$3" },
  { re: /("id_token"\s*:\s*")([^"]+)(")/gi, replacement: "$1[REDACTED]$3" },
];

export function redactSensitiveText(value: string, opts?: { homeDir?: string }): string {
  let out = String(value ?? "");
  for (const rule of SENSITIVE_RULES) {
    out = out.replace(rule.re, rule.replacement);
  }

  const home = opts?.homeDir ?? homedir();
  if (home) out = out.split(home).join("~");
  return out;
}
