import {
  CLAIM_KEY_ORDER,
  type ClaimIssue,
  type ClaimV1,
  type ClaimsCanonicalizeResult,
  type ClaimsSchemaValidator,
  type ClaimsValidationResult,
  type ParsedClaimLine,
} from "./types";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function compareClaims(a: ClaimV1, b: ClaimV1): number {
  if (a.domain < b.domain) return -1;
  if (a.domain > b.domain) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function formatSchemaIssueMessage(issuePath: string, issueMessage: string): string {
  if (!issuePath) return `schema validation failed: ${issueMessage}`;
  return `schema validation failed at ${issuePath}: ${issueMessage}`;
}

function claimToOrderedRecord(claim: ClaimV1): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of CLAIM_KEY_ORDER) {
    ordered[key] = claim[key];
  }
  return ordered;
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

export function parseClaimsJsonl(input: string): { claims: ParsedClaimLine[]; issues: ClaimIssue[] } {
  const normalized = normalizeNewlines(input);
  const lines = normalized.split("\n");
  const claims: ParsedClaimLine[] = [];
  const issues: ClaimIssue[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNumber = idx + 1;
    const raw = lines[idx] ?? "";
    const line = raw.trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      const objectValue = asObject(parsed);
      if (!objectValue) {
        issues.push({
          code: "E_PARSE_NOT_OBJECT",
          line: lineNumber,
          message: "claim line must be a JSON object",
        });
        continue;
      }
      claims.push({ line: lineNumber, value: objectValue });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({
        code: "E_PARSE_JSON",
        line: lineNumber,
        message: `invalid JSON: ${message}`,
      });
    }
  }

  return { claims, issues };
}

export function validateParsedClaims(
  parsedClaims: readonly ParsedClaimLine[],
  options: {
    validateSchema: ClaimsSchemaValidator;
    allowedDomains: ReadonlySet<string>;
  }
): ClaimsValidationResult {
  const claims: ClaimV1[] = [];
  const issues: ClaimIssue[] = [];

  for (const parsed of parsedClaims) {
    const isValid = options.validateSchema(parsed.value);
    if (!isValid) {
      const schemaIssues = options.validateSchema.errors ?? [{ message: "schema validation failed" }];
      for (const schemaIssue of schemaIssues) {
        const issuePath = schemaIssue.instancePath ?? "";
        const issueMessage = schemaIssue.message ?? "schema validation failed";
        issues.push({
          code: "E_SCHEMA",
          line: parsed.line,
          path: issuePath,
          message: formatSchemaIssueMessage(issuePath, issueMessage),
        });
      }
      continue;
    }

    const claim = parsed.value as ClaimV1;
    if (!options.allowedDomains.has(claim.domain)) {
      issues.push({
        code: "E_DOMAIN_UNKNOWN",
        line: parsed.line,
        path: "/domain",
        message: `unknown domain \"${claim.domain}\"; add it to claims/domains.json`,
      });
      continue;
    }

    claims.push(claim);
  }

  const firstSeenById = new Map<string, number>();
  for (const parsed of parsedClaims) {
    const claim = parsed.value as Partial<ClaimV1>;
    if (typeof claim.id !== "string" || claim.id.length === 0) continue;
    const firstLine = firstSeenById.get(claim.id);
    if (typeof firstLine === "number") {
      issues.push({
        code: "E_ID_DUPLICATE",
        line: parsed.line,
        path: "/id",
        message: `duplicate id \"${claim.id}\": first seen on line ${firstLine}, repeated on line ${parsed.line}`,
      });
      continue;
    }
    firstSeenById.set(claim.id, parsed.line);
  }

  return { claims, issues };
}

export function canonicalizeClaims(claims: readonly ClaimV1[]): string {
  const sorted = [...claims].sort(compareClaims);
  const lines = sorted.map((claim) => JSON.stringify(claimToOrderedRecord(claim)));
  return `${lines.join("\n")}\n`;
}

export function validateAndCanonicalizeClaimsJsonl(
  input: string,
  options: {
    validateSchema: ClaimsSchemaValidator;
    allowedDomains: ReadonlySet<string>;
  }
): ClaimsCanonicalizeResult {
  const parsed = parseClaimsJsonl(input);
  const validated = validateParsedClaims(parsed.claims, options);
  const issues = [...parsed.issues, ...validated.issues];

  if (issues.length > 0) {
    return {
      claims: validated.claims,
      issues,
      canonicalText: null,
    };
  }

  return {
    claims: validated.claims,
    issues,
    canonicalText: canonicalizeClaims(validated.claims),
  };
}
