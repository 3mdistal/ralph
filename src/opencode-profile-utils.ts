export type RequestedOpencodeProfile = string | "auto" | null;

export function resolveRequestedOpencodeProfile(params: {
  controlProfile?: string | null;
  defaultProfile?: string | null;
}): RequestedOpencodeProfile {
  const controlProfile = (params.controlProfile ?? "").trim();
  if (controlProfile === "auto") return "auto";
  if (controlProfile) return controlProfile;

  const defaultProfile = (params.defaultProfile ?? "").trim();
  if (!defaultProfile) return null;
  return defaultProfile === "auto" ? "auto" : defaultProfile;
}
