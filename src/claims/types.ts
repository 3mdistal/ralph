export const CLAIM_KEY_ORDER = [
  "schemaVersion",
  "domain",
  "id",
  "surface",
  "path",
  "claim",
  "status",
  "source",
] as const;

export type ClaimKey = (typeof CLAIM_KEY_ORDER)[number];

export type ClaimStatus = "implemented" | "planned";

export interface ClaimV1 {
  schemaVersion: 1;
  domain: string;
  id: string;
  surface: string;
  path: string;
  claim: string;
  status: ClaimStatus;
  source: string;
}

export interface ParsedClaimLine {
  line: number;
  value: unknown;
}

export type ClaimIssueCode =
  | "E_PARSE_JSON"
  | "E_PARSE_NOT_OBJECT"
  | "E_SCHEMA"
  | "E_DOMAIN_UNKNOWN"
  | "E_ID_DUPLICATE";

export interface ClaimIssue {
  code: ClaimIssueCode;
  line: number;
  message: string;
  path?: string;
}

export type SchemaIssue = {
  instancePath?: string;
  message?: string;
};

export type ClaimsSchemaValidator = ((value: unknown) => boolean) & {
  errors?: readonly SchemaIssue[] | null;
};

export interface ClaimsValidationResult {
  claims: ClaimV1[];
  issues: ClaimIssue[];
}

export interface ClaimsCanonicalizeResult extends ClaimsValidationResult {
  canonicalText: string | null;
}
