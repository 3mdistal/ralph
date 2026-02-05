import { readdir as readdirFs } from "fs/promises";
import { existsSync as existsSyncFs } from "fs";
import { join } from "path";
import { homedir as homedirFs } from "os";

import type { AgentTask } from "../queue-backend";
import {
  getRequestedOpencodeProfileName,
  isOpencodeProfilesEnabled,
  listOpencodeProfileNames,
  resolveOpencodeProfile,
} from "../config";
import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "../opencode-auto-profile";
import type { getThrottleDecision } from "../throttle";

export type OpencodeXdg = {
  dataHome?: string;
  configHome?: string;
  stateHome?: string;
  cacheHome?: string;
};

export type ResolveOpencodeXdgResult = {
  profileName: string | null;
  opencodeXdg?: OpencodeXdg;
  error?: string;
};

export type ResolveOpencodeXdgForTaskOptions = {
  task: AgentTask;
  phase: "start" | "resume";
  sessionId?: string;
  repo: string;
  getThrottleDecision: typeof getThrottleDecision;
  nowMs?: number;
  envHome?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  homedir?: () => string;
  readdir?: typeof readdirFs;
  existsSync?: typeof existsSyncFs;
};

export function getPinnedOpencodeProfileName(task: AgentTask): string | null {
  const raw = task["opencode-profile"];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

export async function resolveOpencodeXdgForTask(
  opts: ResolveOpencodeXdgForTaskOptions
): Promise<ResolveOpencodeXdgResult> {
  if (!isOpencodeProfilesEnabled()) return { profileName: null };

  const nowMs = opts.nowMs ?? Date.now();
  const envHome = opts.envHome ?? process.env.HOME;
  const homedir = opts.homedir ?? homedirFs;
  const readdir = opts.readdir ?? readdirFs;
  const existsSync = opts.existsSync ?? existsSyncFs;
  const log = opts.log ?? ((message: string) => console.log(message));
  const warn = opts.warn ?? ((message: string) => console.warn(message));

  const home = envHome ?? homedir();
  const ambientXdg = {
    dataHome: join(home, ".local", "share"),
    configHome: join(home, ".config"),
    stateHome: join(home, ".local", "state"),
    cacheHome: join(home, ".cache"),
  };

  const pinned = getPinnedOpencodeProfileName(opts.task);

  if (pinned) {
    const resolved = resolveOpencodeProfile(pinned);
    if (!resolved) {
      return {
        profileName: pinned,
        error:
          `Task is pinned to an unknown OpenCode profile ${JSON.stringify(pinned)} (task ${opts.task.issue}). ` +
          `Configure it under [opencode.profiles.${pinned}] in ~/.ralph/config.toml (paths must be absolute; no '~' expansion).`,
      };
    }

    return {
      profileName: resolved.name,
      opencodeXdg: {
        dataHome: resolved.xdgDataHome,
        configHome: resolved.xdgConfigHome,
        stateHome: resolved.xdgStateHome,
        cacheHome: resolved.xdgCacheHome,
      },
    };
  }

  if (opts.phase === "resume") {
    if (!opts.sessionId) {
      return { profileName: null, opencodeXdg: ambientXdg };
    }

    const candidates = listOpencodeProfileNames();
    for (const name of candidates) {
      const resolved = resolveOpencodeProfile(name);
      if (!resolved) continue;
      const base = join(resolved.xdgDataHome, "opencode", "storage", "session");
      if (!existsSync(base)) continue;
      try {
        const dirs = await readdir(base, { withFileTypes: true });
        for (const dir of dirs) {
          if (!dir.isDirectory()) continue;
          const sessionPath = join(base, dir.name, `${opts.sessionId}.json`);
          if (existsSync(sessionPath)) {
            return {
              profileName: resolved.name,
              opencodeXdg: {
                dataHome: resolved.xdgDataHome,
                configHome: resolved.xdgConfigHome,
                stateHome: resolved.xdgStateHome,
                cacheHome: resolved.xdgCacheHome,
              },
            };
          }
        }
      } catch {
        // best-effort
      }
    }

    return { profileName: null, opencodeXdg: ambientXdg };
  }

  // Source of truth is config (opencode.defaultProfile). The control file no longer controls profile.
  const requested = getRequestedOpencodeProfileName(null);

  let resolved = null as ReturnType<typeof resolveOpencodeProfile>;

  if (requested === "auto") {
    const chosen = await resolveAutoOpencodeProfileName(nowMs, {
      getThrottleDecision: opts.getThrottleDecision,
    });
    if (opts.phase === "start") {
      log(`[ralph:worker:${opts.repo}] Auto-selected OpenCode profile=${JSON.stringify(chosen ?? "")}`);
    }
    resolved = chosen ? resolveOpencodeProfile(chosen) : resolveOpencodeProfile(null);
  } else if (opts.phase === "start") {
    const selection = await resolveOpencodeProfileForNewWork(nowMs, requested || null, {
      getThrottleDecision: opts.getThrottleDecision,
    });
    const chosen = selection.profileName;

    if (selection.source === "failover") {
      log(
        `[ralph:worker:${opts.repo}] Hard throttle on profile=${selection.requestedProfile ?? "default"}; ` +
          `failing over to profile=${chosen ?? "ambient"}`
      );
    }

    resolved = chosen ? resolveOpencodeProfile(chosen) : null;
  } else {
    resolved = requested ? resolveOpencodeProfile(requested) : null;
  }

  if (!resolved) {
    if (opts.phase === "start" && requested) {
      warn(`[ralph:worker:${opts.repo}] Unable to resolve OpenCode profile for new task; running with ambient XDG dirs`);
    }
    return { profileName: null };
  }

  return {
    profileName: resolved.name,
    opencodeXdg: {
      dataHome: resolved.xdgDataHome,
      configHome: resolved.xdgConfigHome,
      stateHome: resolved.xdgStateHome,
      cacheHome: resolved.xdgCacheHome,
    },
  };
}
