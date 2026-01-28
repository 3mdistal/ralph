export type SeedManifestVersion = "v1";

export type SeedManifest = {
  version: SeedManifestVersion;
  seedLabel: string;
  marker: string;
  labels?: SeedLabelSpec[];
  labelRenames?: SeedLabelRename[];
  scenarios: SeedScenario[];
};

export type SeedLabelSpec = {
  name: string;
  color: string;
  description?: string | null;
};

export type SeedLabelRename = {
  from: string;
  to: string;
  description?: string | null;
};

export type SeedScenario = {
  slug: string;
  title: string;
  state?: "open" | "closed";
  labels?: string[];
  body?: SeedBodySpec;
  relationships?: SeedScenarioRelationships;
  capabilities?: SeedScenarioCapabilities;
};

export type SeedScenarioCapabilities = {
  blockedByApi?: "required" | "best-effort";
  subIssuesApi?: "required" | "best-effort";
};

export type SeedScenarioRelationships = {
  blockedBy?: SeedRelationshipSpec[];
  subIssues?: SeedRelationshipSpec[];
};

export type SeedRelationshipSpec = {
  slug: string;
  source: "api" | "body";
  checked?: boolean;
  note?: string;
};

export type SeedBodySpec = {
  intro?: string;
  blockedBy?: Array<{ slug: string; checked?: boolean; note?: string }>;
  blocks?: Array<{ slug: string; checked?: boolean; note?: string }>;
  taskList?: Array<{ slug?: string; text?: string; checked?: boolean }>;
  implicitBlockedBy?: string;
  footer?: string;
};

type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateLabelSpec(label: SeedLabelSpec, errors: string[], path: string): void {
  if (!isNonEmptyString(label.name)) errors.push(`${path}.name must be a non-empty string`);
  if (!isNonEmptyString(label.color)) errors.push(`${path}.color must be a non-empty string`);
}

function validateRelationshipSpec(rel: SeedRelationshipSpec, errors: string[], path: string): void {
  if (!isNonEmptyString(rel.slug)) errors.push(`${path}.slug must be a non-empty string`);
  if (rel.source !== "api" && rel.source !== "body") errors.push(`${path}.source must be "api" or "body"`);
}

function validateBodySpec(body: SeedBodySpec, errors: string[], path: string): void {
  for (const key of ["intro", "implicitBlockedBy", "footer"] as const) {
    const value = body[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      errors.push(`${path}.${key} must be a string`);
    }
  }

  const validateRefList = (
    list: Array<{ slug: string; checked?: boolean; note?: string }> | undefined,
    listPath: string
  ) => {
    if (!list) return;
    if (!Array.isArray(list)) {
      errors.push(`${listPath} must be an array`);
      return;
    }
    list.forEach((item, idx) => {
      if (!isNonEmptyString(item.slug)) errors.push(`${listPath}[${idx}].slug must be a non-empty string`);
      if (item.note !== undefined && item.note !== null && typeof item.note !== "string") {
        errors.push(`${listPath}[${idx}].note must be a string`);
      }
    });
  };

  validateRefList(body.blockedBy, `${path}.blockedBy`);
  validateRefList(body.blocks, `${path}.blocks`);

  if (body.taskList !== undefined) {
    if (!Array.isArray(body.taskList)) {
      errors.push(`${path}.taskList must be an array`);
    } else {
      body.taskList.forEach((item, idx) => {
        const hasSlug = isNonEmptyString(item.slug);
        const hasText = isNonEmptyString(item.text);
        if (!hasSlug && !hasText) {
          errors.push(`${path}.taskList[${idx}] must include slug or text`);
        }
      });
    }
  }
}

function validateScenario(scenario: SeedScenario, errors: string[], index: number): void {
  const path = `scenarios[${index}]`;
  if (!isNonEmptyString(scenario.slug)) errors.push(`${path}.slug must be a non-empty string`);
  if (!isNonEmptyString(scenario.title)) errors.push(`${path}.title must be a non-empty string`);
  if (scenario.state && scenario.state !== "open" && scenario.state !== "closed") {
    errors.push(`${path}.state must be "open" or "closed"`);
  }
  if (scenario.labels && !Array.isArray(scenario.labels)) {
    errors.push(`${path}.labels must be an array`);
  }
  if (scenario.body) validateBodySpec(scenario.body, errors, `${path}.body`);
  if (scenario.relationships?.blockedBy) {
    scenario.relationships.blockedBy.forEach((rel, idx) =>
      validateRelationshipSpec(rel, errors, `${path}.relationships.blockedBy[${idx}]`)
    );
  }
  if (scenario.relationships?.subIssues) {
    scenario.relationships.subIssues.forEach((rel, idx) =>
      validateRelationshipSpec(rel, errors, `${path}.relationships.subIssues[${idx}]`)
    );
  }
  if (scenario.capabilities) {
    const blockedBy = scenario.capabilities.blockedByApi;
    const subIssues = scenario.capabilities.subIssuesApi;
    if (blockedBy && blockedBy !== "required" && blockedBy !== "best-effort") {
      errors.push(`${path}.capabilities.blockedByApi must be "required" or "best-effort"`);
    }
    if (subIssues && subIssues !== "required" && subIssues !== "best-effort") {
      errors.push(`${path}.capabilities.subIssuesApi must be "required" or "best-effort"`);
    }
  }
}

export function validateSeedManifest(manifest: SeedManifest): ValidationResult {
  const errors: string[] = [];
  if (manifest.version !== "v1") errors.push(`version must be "v1"`);
  if (!isNonEmptyString(manifest.seedLabel)) errors.push(`seedLabel must be a non-empty string`);
  if (!isNonEmptyString(manifest.marker)) errors.push(`marker must be a non-empty string`);
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
    errors.push(`scenarios must be a non-empty array`);
  } else {
    manifest.scenarios.forEach((scenario, idx) => validateScenario(scenario, errors, idx));
  }
  if (manifest.labels) {
    if (!Array.isArray(manifest.labels)) {
      errors.push(`labels must be an array`);
    } else {
      manifest.labels.forEach((label, idx) => validateLabelSpec(label, errors, `labels[${idx}]`));
    }
  }
  if (manifest.labelRenames) {
    if (!Array.isArray(manifest.labelRenames)) {
      errors.push(`labelRenames must be an array`);
    } else {
      manifest.labelRenames.forEach((rename, idx) => {
        const path = `labelRenames[${idx}]`;
        if (!isNonEmptyString(rename.from)) errors.push(`${path}.from must be a non-empty string`);
        if (!isNonEmptyString(rename.to)) errors.push(`${path}.to must be a non-empty string`);
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function parseSeedManifest(raw: string): SeedManifest {
  let parsed: SeedManifest;
  try {
    parsed = JSON.parse(raw) as SeedManifest;
  } catch (error) {
    throw new Error(`Seed manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateSeedManifest(parsed);
  if (!validation.ok) {
    throw new Error(`Seed manifest validation failed:\n- ${validation.errors.join("\n- ")}`);
  }
  return parsed;
}

export function listManifestSlugs(manifest: SeedManifest): string[] {
  return manifest.scenarios.map((scenario) => scenario.slug);
}
