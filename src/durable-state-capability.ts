export type DurableStateCapabilityVerdict =
  | "readable_writable"
  | "readable_readonly_forward_newer"
  | "unreadable_forward_incompatible"
  | "unreadable_invariant_failure";

export type DurableStateSchemaWindow = {
  minReadableSchema: number;
  maxReadableSchema: number;
  maxWritableSchema: number;
};

export type DurableStateCapability = {
  schemaVersion: number;
  minReadableSchema: number;
  maxReadableSchema: number;
  maxWritableSchema: number;
  readable: boolean;
  writable: boolean;
  verdict: DurableStateCapabilityVerdict;
};

function normalizePositiveInt(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid durable-state schema window: ${label} must be finite`);
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    throw new Error(`Invalid durable-state schema window: ${label} must be > 0`);
  }
  return normalized;
}

export function normalizeSchemaWindow(window: DurableStateSchemaWindow): DurableStateSchemaWindow {
  const minReadableSchema = normalizePositiveInt(window.minReadableSchema, "minReadableSchema");
  const maxReadableSchema = normalizePositiveInt(window.maxReadableSchema, "maxReadableSchema");
  const maxWritableSchema = normalizePositiveInt(window.maxWritableSchema, "maxWritableSchema");
  if (maxReadableSchema < maxWritableSchema) {
    throw new Error("Invalid durable-state schema window: maxReadableSchema must be >= maxWritableSchema");
  }
  if (maxWritableSchema < minReadableSchema) {
    throw new Error("Invalid durable-state schema window: maxWritableSchema must be >= minReadableSchema");
  }
  return {
    minReadableSchema,
    maxReadableSchema,
    maxWritableSchema,
  };
}

export function evaluateDurableStateCapability(params: {
  schemaVersion: number;
  window: DurableStateSchemaWindow;
}): DurableStateCapability {
  const schemaVersion = normalizePositiveInt(params.schemaVersion, "schemaVersion");
  const window = normalizeSchemaWindow(params.window);

  if (schemaVersion < window.minReadableSchema || schemaVersion > window.maxReadableSchema) {
    return {
      schemaVersion,
      ...window,
      readable: false,
      writable: false,
      verdict: "unreadable_forward_incompatible",
    };
  }

  if (schemaVersion > window.maxWritableSchema) {
    return {
      schemaVersion,
      ...window,
      readable: true,
      writable: false,
      verdict: "readable_readonly_forward_newer",
    };
  }

  return {
    schemaVersion,
    ...window,
    readable: true,
    writable: true,
    verdict: "readable_writable",
  };
}

export function formatReadableSchemaRange(window: DurableStateSchemaWindow): string {
  const normalized = normalizeSchemaWindow(window);
  return `${normalized.minReadableSchema}..${normalized.maxReadableSchema}`;
}

export function formatWritableSchemaRange(window: DurableStateSchemaWindow): string {
  const normalized = normalizeSchemaWindow(window);
  return `${normalized.minReadableSchema}..${normalized.maxWritableSchema}`;
}
