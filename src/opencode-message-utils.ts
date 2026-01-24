export function extractProviderId(message: any): string | null {
  const direct = typeof message?.providerID === "string" ? message.providerID : null;
  if (direct) return direct;

  const alt = typeof message?.providerId === "string" ? message.providerId : null;
  if (alt) return alt;

  const nested = typeof message?.provider?.id === "string" ? message.provider.id : null;
  if (nested) return nested;

  return null;
}

export function extractRole(message: any): string | null {
  return typeof message?.role === "string" ? message.role : null;
}
