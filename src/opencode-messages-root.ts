import { homedir } from "os";
import { join } from "path";

import { resolveOpencodeProfile } from "./config";

export type OpencodeMessagesRoot = {
  effectiveProfile: string | null;
  xdgDataHome: string;
  messagesRootDir: string;
};

export function resolveDefaultXdgDataHome(homeDir: string = homedir()): string {
  const raw = process.env.XDG_DATA_HOME?.trim();
  return raw ? raw : join(homeDir, ".local", "share");
}

export function resolveOpencodeMessagesRootDir(opencodeProfile?: string | null): OpencodeMessagesRoot {
  const requested = (opencodeProfile ?? "").trim();
  if (requested) {
    const resolved = resolveOpencodeProfile(requested);
    if (resolved) {
      return {
        effectiveProfile: resolved.name,
        xdgDataHome: resolved.xdgDataHome,
        messagesRootDir: join(resolved.xdgDataHome, "opencode", "storage", "message"),
      };
    }

    const xdgDataHome = resolveDefaultXdgDataHome();
    return { effectiveProfile: null, xdgDataHome, messagesRootDir: join(xdgDataHome, "opencode", "storage", "message") };
  }

  const resolvedDefault = resolveOpencodeProfile(null);
  if (resolvedDefault) {
    return {
      effectiveProfile: resolvedDefault.name,
      xdgDataHome: resolvedDefault.xdgDataHome,
      messagesRootDir: join(resolvedDefault.xdgDataHome, "opencode", "storage", "message"),
    };
  }

  const xdgDataHome = resolveDefaultXdgDataHome();
  return { effectiveProfile: null, xdgDataHome, messagesRootDir: join(xdgDataHome, "opencode", "storage", "message") };
}
