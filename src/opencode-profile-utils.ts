export type RequestedOpencodeProfile = string | "auto" | null;

export function resolveRequestedOpencodeProfile(params: {
  defaultProfile?: string | null;
}): RequestedOpencodeProfile {
  const defaultProfile = (params.defaultProfile ?? "").trim();
  if (!defaultProfile) return null;
  return defaultProfile === "auto" ? "auto" : defaultProfile;
}
