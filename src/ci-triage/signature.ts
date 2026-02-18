import { redactSensitiveText } from "../redaction";
import { createHash } from "crypto";

export type CiFailureSignatureV2 = {
  version: 2;
  signature: string;
  components: {
    timedOut: boolean;
    failures: Array<{ name: string; rawState: string; excerptFingerprint: string | null }>;
  };
};

export type CiFailureSignatureV3 = {
  version: 3;
  signature: string;
  components: {
    timedOut: boolean;
    failures: Array<{ name: string; rawState: string; excerptFingerprint: string | null }>;
  };
};

export type CiFailureSignatureEntry = {
  name: string;
  rawState: string;
  excerpt?: string | null;
};

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const EXCERPT_FINGERPRINT_CHARS = 2000;

function hashFNV1a(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hashSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeExcerptFingerprint(excerpt: string | null | undefined): string | null {
  if (!excerpt) return null;
  const redacted = redactSensitiveText(excerpt).trim();
  if (!redacted) return null;
  const clipped = redacted.length > EXCERPT_FINGERPRINT_CHARS ? redacted.slice(0, EXCERPT_FINGERPRINT_CHARS) : redacted;
  return hashFNV1a(clipped);
}

export function buildCiFailureSignatureV2(params: {
  timedOut: boolean;
  failures: CiFailureSignatureEntry[];
}): CiFailureSignatureV2 {
  const failures = params.failures
    .map((failure) => ({
      name: failure.name.trim(),
      rawState: failure.rawState.trim(),
      excerptFingerprint: normalizeExcerptFingerprint(failure.excerpt ?? null),
    }))
    .sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      if (a.rawState !== b.rawState) return a.rawState.localeCompare(b.rawState);
      return (a.excerptFingerprint ?? "").localeCompare(b.excerptFingerprint ?? "");
    });

  const payload = JSON.stringify({ timedOut: params.timedOut, failures });
  return {
    version: 2,
    signature: hashFNV1a(payload),
    components: {
      timedOut: params.timedOut,
      failures,
    },
  };
}

export function buildCiFailureSignatureV3(params: {
  timedOut: boolean;
  failures: CiFailureSignatureEntry[];
}): CiFailureSignatureV3 {
  const failures = params.failures
    .map((failure) => ({
      name: failure.name.trim(),
      rawState: failure.rawState.trim(),
      excerptFingerprint: normalizeExcerptFingerprint(failure.excerpt ?? null),
    }))
    .sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      if (a.rawState !== b.rawState) return a.rawState.localeCompare(b.rawState);
      return (a.excerptFingerprint ?? "").localeCompare(b.excerptFingerprint ?? "");
    });

  const payload = JSON.stringify({ timedOut: params.timedOut, failures });
  return {
    version: 3,
    signature: hashSha256(payload),
    components: {
      timedOut: params.timedOut,
      failures,
    },
  };
}
