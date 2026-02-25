interface DomainsJson {
  domains?: Array<{ id?: unknown }>;
}

export function parseAllowedDomains(value: unknown): ReadonlySet<string> {
  const parsed = value as DomainsJson;
  if (!parsed || !Array.isArray(parsed.domains)) {
    throw new Error("Invalid domains payload: expected object with domains[]");
  }

  const ids = parsed.domains
    .map((domain) => domain.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return new Set(ids);
}
