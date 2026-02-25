import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildClaimsSchemaValidator, parseAllowedDomains, validateAndCanonicalizeClaimsJsonl } from "../src/claims";

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

function parseArgs(argv: string[]): { check: boolean } {
  return {
    check: argv.includes("--check"),
  };
}

function printUsage(): void {
  console.log("Usage: bun run scripts/claims-canonicalize.ts [--check]");
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    return 0;
  }

  const unsupported = args.filter((arg) => arg !== "--check");
  if (unsupported.length > 0) {
    console.error(`Unsupported argument(s): ${unsupported.join(", ")}`);
    printUsage();
    return 1;
  }

  const { check } = parseArgs(args);
  const canonicalPath = resolve(process.cwd(), "claims/canonical.jsonl");
  const schemaPath = resolve(process.cwd(), "claims/schema.v1.json");
  const domainsPath = resolve(process.cwd(), "claims/domains.json");

  const rawClaims = readFileSync(canonicalPath, "utf8");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
  const allowedDomains = parseAllowedDomains(JSON.parse(readFileSync(domainsPath, "utf8")) as unknown);
  const validateSchema = buildClaimsSchemaValidator(schema);

  const result = validateAndCanonicalizeClaimsJsonl(rawClaims, {
    validateSchema,
    allowedDomains,
  });

  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      const path = issue.path ? ` ${issue.path}` : "";
      console.error(`${canonicalPath}:${issue.line} ${issue.code}${path} ${issue.message}`);
    }
    console.error(`claims canonicalization failed (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"})`);
    return 1;
  }

  const normalizedRaw = normalizeNewlines(rawClaims);
  const formatted = result.canonicalText ?? "";

  if (check) {
    if (normalizedRaw !== formatted) {
      console.error("claims/canonical.jsonl is not canonical; run: bun run claims:fmt");
      return 1;
    }
    console.log("claims/canonical.jsonl is canonical");
    return 0;
  }

  if (normalizedRaw !== formatted) {
    writeFileSync(canonicalPath, formatted, "utf8");
    console.log("canonicalized claims/canonical.jsonl");
    return 0;
  }

  console.log("claims/canonical.jsonl already canonical");
  return 0;
}

process.exitCode = main();
