import { isAbsolute, join } from "path";

import { getBwrbVaultIfValid } from "../queue-backend";

export function resolveVaultPath(p: string): string {
  const vault = getBwrbVaultIfValid();
  if (!vault) return p;
  return isAbsolute(p) ? p : join(vault, p);
}
