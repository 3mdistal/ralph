import Ajv2020, { type AnySchema, type ErrorObject } from "ajv/dist/2020";

import type { ClaimsSchemaValidator, SchemaIssue } from "./types";

function toSchemaIssue(error: ErrorObject<string, Record<string, unknown>, unknown>): SchemaIssue {
  return {
    instancePath: error.instancePath,
    message: error.message,
  };
}

export function buildClaimsSchemaValidator(schema: unknown): ClaimsSchemaValidator {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
  });
  const validate = ajv.compile(schema as AnySchema);

  const wrapped = ((value: unknown): boolean => {
    const ok = validate(value) as boolean;
    wrapped.errors = (validate.errors ?? []).map(toSchemaIssue);
    return ok;
  }) as ClaimsSchemaValidator;

  wrapped.errors = [];
  return wrapped;
}
