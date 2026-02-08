import { readdir as readdirFs } from "fs/promises";
import { existsSync as existsSyncFs } from "fs";
import { join } from "path";

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
  error?: OpencodeProfileResolutionError;
};

export type OpencodeProfileResolutionErrorCode = "profile-unresolvable";

export type OpencodeProfileResolutionReasonCode =
  | "pinned-profile-missing"
  | "start-profile-unresolvable"
  | "resume-session-id-missing"
  | "resume-session-not-found";

export type OpencodeProfileResolutionError = {
  code: OpencodeProfileResolutionErrorCode;
  reasonCode: OpencodeProfileResolutionReasonCode;
  message: string;
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

function buildProfileUnresolvableError(
  reasonCode: OpencodeProfileResolutionReasonCode,
  message: string
): OpencodeProfileResolutionError {
  return {
    code: "profile-unresolvable",
    reasonCode,
    message,
  };
}

export async function resolveOpencodeXdgForTask(
  opts: ResolveOpencodeXdgForTaskOptions
): Promise<ResolveOpencodeXdgResult> {
  if (!isOpencodeProfilesEnabled()) return { profileName: null };

  const nowMs = opts.nowMs ?? Date.now();
  const readdir = opts.readdir ?? readdirFs;
  const existsSync = opts.existsSync ?? existsSyncFs;
  const log = opts.log ?? ((message: string) => console.log(message));
  const warn = opts.warn ?? ((message: string) => console.warn(message));

  const pinned = getPinnedOpencodeProfileName(opts.task);

  if (pinned) {
    const resolved = resolveOpencodeProfile(pinned);
    if (!resolved) {
      return {
        profileName: pinned,
        error: buildProfileUnresolvableError(
          "pinned-profile-missing",
          `Task is pinned to an unknown OpenCode profile ${JSON.stringify(pinned)} (task ${opts.task.issue}). ` +
            `Configure it under [opencode.profiles.${pinned}] in ~/.ralph/config.toml (paths must be absolute; no '~' expansion).`
        ),
      };
    }

    return {
      profileName: resolved.name,
      opencodeXdg: {
        dataHome: resolved.xdgDataHome,
        stateHome: resolved.xdgStateHome,
        cacheHome: resolved.xdgCacheHome,
      },
    };
  }

  if (opts.phase === "resume") {
    if (!opts.sessionId) {
      return {
        profileName: null,
        error: buildProfileUnresolvableError(
          "resume-session-id-missing",
          `OpenCode profiles are enabled but resume has no session id for task ${opts.task.issue}. ` +
            "Cannot resolve a profile deterministically; re-queue with a valid session-id or restart the task."
        ),
      };
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

    return {
      profileName: null,
      error: buildProfileUnresolvableError(
        "resume-session-not-found",
        `Unable to locate OpenCode session ${JSON.stringify(opts.sessionId)} in any configured profile for task ${opts.task.issue}. ` +
          "No ambient fallback is allowed while profiles are enabled; fix profile mapping/session storage and re-queue."
      ),
    };
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
          `failing over to profile=${chosen ?? "unresolved"}`
      );
    }

    resolved = chosen ? resolveOpencodeProfile(chosen) : null;
  } else {
    resolved = requested ? resolveOpencodeProfile(requested) : null;
  }

  if (!resolved) {
    const profileHint =
      requested === "auto"
        ? "auto profile selection did not resolve to a configured profile"
        : `requested profile ${JSON.stringify(requested || "default")} is not configured`;
    warn(`[ralph:worker:${opts.repo}] Unable to resolve OpenCode profile for new task; failing closed`);
    return {
      profileName: null,
      error: buildProfileUnresolvableError(
        "start-profile-unresolvable",
        `OpenCode profiles are enabled but ${profileHint} for task ${opts.task.issue}. ` +
          "No ambient fallback is allowed; configure opencode.defaultProfile/opencode.profiles and re-queue."
      ),
    };
  }

  return {
    profileName: resolved.name,
    opencodeXdg: {
      dataHome: resolved.xdgDataHome,
      stateHome: resolved.xdgStateHome,
      cacheHome: resolved.xdgCacheHome,
    },
  };
}
