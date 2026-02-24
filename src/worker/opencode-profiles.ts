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
  error?: string;
};

const PROFILE_UNRESOLVABLE_PREFIX = "blocked:profile-unresolvable";
const SESSION_STORAGE_DIRS = ["session", "session_diff"] as const;
const MAX_RESUME_PROFILE_SCAN = 8;

type ResolvedProfile = NonNullable<ReturnType<typeof resolveOpencodeProfile>>;

function buildProfileUnresolvableError(params: {
  phase: "start" | "resume";
  taskIssue: string;
  reason: string;
  configuredProfiles: string[];
  requestedProfile?: string | null;
  pinnedProfile?: string | null;
  sessionId?: string;
}): string {
  const configured = params.configuredProfiles.length > 0 ? params.configuredProfiles.join(", ") : "(none)";
  const details = [
    `phase=${params.phase}`,
    `task=${params.taskIssue}`,
    `requestedProfile=${params.requestedProfile ?? "(none)"}`,
    `pinnedProfile=${params.pinnedProfile ?? "(none)"}`,
    params.sessionId ? `sessionId=${params.sessionId}` : null,
    `configuredProfiles=${configured}`,
  ]
    .filter(Boolean)
    .join("; ");

  return (
    `${PROFILE_UNRESOLVABLE_PREFIX}: ${params.reason}. ` +
    `OpenCode profiles are enabled, so Ralph refuses ambient fallback. ` +
    `${details}. ` +
    "Configure a valid profile under [opencode.profiles.<name>] in ~/.ralph/config.toml " +
    "(paths must be absolute; no '~' expansion)."
  );
}

export type ResolveOpencodeXdgForTaskOptions = {
  task: AgentTask;
  phase: "start" | "resume";
  sessionId?: string;
  repo: string;
  getThrottleDecision: typeof getThrottleDecision;
  nowMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  readdir?: typeof readdirFs;
  existsSync?: typeof existsSyncFs;
};

async function profileContainsSession(params: {
  profile: ResolvedProfile;
  sessionId: string;
  readdir: typeof readdirFs;
  existsSync: typeof existsSyncFs;
}): Promise<boolean> {
  for (const storageDir of SESSION_STORAGE_DIRS) {
    const base = join(params.profile.xdgDataHome, "opencode", "storage", storageDir);
    if (!params.existsSync(base)) continue;
    try {
      const dirs = await params.readdir(base, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const sessionPath = join(base, dir.name, `${params.sessionId}.json`);
        if (params.existsSync(sessionPath)) return true;
      }
    } catch {
      // best-effort
    }
  }

  return false;
}

function profileToXdg(profile: ResolvedProfile): OpencodeXdg {
  return {
    dataHome: profile.xdgDataHome,
    stateHome: profile.xdgStateHome,
    cacheHome: profile.xdgCacheHome,
  };
}

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
  const readdir = opts.readdir ?? readdirFs;
  const existsSync = opts.existsSync ?? existsSyncFs;
  const log = opts.log ?? ((message: string) => console.log(message));
  const warn = opts.warn ?? ((message: string) => console.warn(message));

  const pinned = getPinnedOpencodeProfileName(opts.task);

  if (pinned && opts.phase !== "resume") {
    const resolved = resolveOpencodeProfile(pinned);
    if (!resolved) {
      return {
        profileName: pinned,
        error: buildProfileUnresolvableError({
          phase: opts.phase,
          taskIssue: opts.task.issue,
          reason: `Task is pinned to unknown OpenCode profile ${JSON.stringify(pinned)}`,
          configuredProfiles: listOpencodeProfileNames(),
          pinnedProfile: pinned,
          sessionId: undefined,
        }),
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
        error: buildProfileUnresolvableError({
          phase: "resume",
          taskIssue: opts.task.issue,
          reason: "Resume requires a session ID to resolve the OpenCode profile",
          configuredProfiles: listOpencodeProfileNames(),
        }),
      };
    }

    const configuredProfileNames = listOpencodeProfileNames();
    const configuredResolved: ResolvedProfile[] = configuredProfileNames
      .map((name) => resolveOpencodeProfile(name))
      .filter((profile): profile is ResolvedProfile => Boolean(profile));

    const preferred = pinned ? resolveOpencodeProfile(pinned) : null;
    if (pinned && !preferred) {
      return {
        profileName: pinned,
        error: buildProfileUnresolvableError({
          phase: "resume",
          taskIssue: opts.task.issue,
          reason: `Task is pinned to unknown OpenCode profile ${JSON.stringify(pinned)}`,
          configuredProfiles: configuredProfileNames,
          pinnedProfile: pinned,
          sessionId: opts.sessionId,
        }),
      };
    }
    const orderedCandidates: ResolvedProfile[] = preferred
      ? [preferred, ...configuredResolved.filter((profile) => profile.name !== preferred.name)]
      : configuredResolved;

    const boundedCandidates = orderedCandidates.slice(0, MAX_RESUME_PROFILE_SCAN);
    const scannedProfileNames: string[] = [];

    for (const candidate of boundedCandidates) {
      scannedProfileNames.push(candidate.name);
      const hasSession = await profileContainsSession({
        profile: candidate,
        sessionId: opts.sessionId,
        readdir,
        existsSync,
      });
      if (!hasSession) continue;

      if (preferred && preferred.name !== candidate.name) {
        warn(
          `[ralph:worker:${opts.repo}] Resume session ${JSON.stringify(opts.sessionId)} not found under pinned profile ` +
            `${JSON.stringify(preferred.name)}; falling back to ${JSON.stringify(candidate.name)}`
        );
      }

      return {
        profileName: candidate.name,
        opencodeXdg: profileToXdg(candidate),
      };
    }

    const scanCapped = orderedCandidates.length > boundedCandidates.length;
    const checked = scannedProfileNames.length > 0 ? scannedProfileNames.join(", ") : "(none)";
    const reason =
      `Could not find session ${JSON.stringify(opts.sessionId)} under scanned profiles (${checked})` +
      (scanCapped
        ? `; terminal after bounded fallback (${boundedCandidates.length}/${orderedCandidates.length} configured profiles scanned)`
        : "; terminal: no profile contains the session");

    return {
      profileName: null,
      error: buildProfileUnresolvableError({
        phase: "resume",
        taskIssue: opts.task.issue,
        reason,
        configuredProfiles: configuredProfileNames,
        pinnedProfile: preferred?.name ?? pinned ?? null,
        sessionId: opts.sessionId,
      }),
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
          `failing over to profile=${chosen ?? "ambient"}`
      );
    }

    resolved = chosen ? resolveOpencodeProfile(chosen) : null;
  } else {
    resolved = requested ? resolveOpencodeProfile(requested) : null;
  }

  if (!resolved) {
    const requestedProfile = requested || null;
    const reason =
      requested === "auto"
        ? "Auto profile selection did not resolve to a configured OpenCode profile"
        : requestedProfile
          ? `Requested/default OpenCode profile ${JSON.stringify(requestedProfile)} is not configured`
          : "No OpenCode profile could be resolved for new work";
    warn(
      `[ralph:worker:${opts.repo}] ${PROFILE_UNRESOLVABLE_PREFIX}: ${reason}; refusing ambient fallback while profiles are enabled`
    );
    return {
      profileName: null,
      error: buildProfileUnresolvableError({
        phase: "start",
        taskIssue: opts.task.issue,
        reason,
        configuredProfiles: listOpencodeProfileNames(),
        requestedProfile,
      }),
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
