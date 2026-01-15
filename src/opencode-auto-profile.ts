import { listOpencodeProfileNames } from "./config";
import { getThrottleDecision, type ThrottleDecision } from "./throttle";

type Candidate = {
  name: string;
  state: "ok" | "soft" | "hard";
  resumeAtTs: number | null;
  weeklyNextResetTs: number | null;
  weeklyHardCapTokens: number;
  weeklyUsedTokens: number;
  weeklyRemainingToHard: number;
  rolling5hRemainingToHard: number;
};

type ThrottleDecisionProvider = {
  getThrottleDecision?: typeof getThrottleDecision;
};

const MIN_SWITCH_INTERVAL_MS = 15 * 60 * 1000;
const MIN_REMAINING_FRAC_TO_CHASE_SOONER = 0.05;

let lastAutoChoice: { profile: string; chosenAt: number } | null = null;

function getWindow(snapshot: any, name: string): any | null {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  return windows.find((w: any) => w && typeof w === "object" && w.name === name) ?? null;
}

function toCandidate(name: string, decision: any): Candidate {
  const snapshot = decision?.snapshot ?? {};

  const weekly = getWindow(snapshot, "weekly");
  const rolling5h = getWindow(snapshot, "rolling5h");

  const weeklyHardCapTokens = typeof weekly?.hardCapTokens === "number" ? weekly.hardCapTokens : 0;
  const weeklyUsedTokens = typeof weekly?.usedTokens === "number" ? weekly.usedTokens : 0;

  const weeklyNextResetTs =
    typeof weekly?.weeklyNextResetTs === "number"
      ? weekly.weeklyNextResetTs
      : typeof weekly?.windowEndTs === "number"
        ? weekly.windowEndTs
        : null;

  const weeklyRemainingToHard = weeklyHardCapTokens - weeklyUsedTokens;

  const rollingHardCapTokens = typeof rolling5h?.hardCapTokens === "number" ? rolling5h.hardCapTokens : 0;
  const rollingUsedTokens = typeof rolling5h?.usedTokens === "number" ? rolling5h.usedTokens : 0;
  const rolling5hRemainingToHard = rollingHardCapTokens - rollingUsedTokens;

  return {
    name,
    state: decision?.state === "soft" || decision?.state === "hard" ? decision.state : "ok",
    resumeAtTs: typeof decision?.resumeAtTs === "number" ? decision.resumeAtTs : null,
    weeklyNextResetTs,
    weeklyHardCapTokens,
    weeklyUsedTokens,
    weeklyRemainingToHard,
    rolling5hRemainingToHard,
  };
}

function chooseBest(candidates: Candidate[], now: number): Candidate {
  const nonHard = candidates.filter((c) => c.state !== "hard");
  const pool = nonHard.length > 0 ? nonHard : candidates;

  const withReset = pool.filter((c) => typeof c.weeklyNextResetTs === "number");

  const byRemaining = [...pool].sort((a, b) => {
    if (a.state !== b.state) return a.state === "ok" ? -1 : b.state === "ok" ? 1 : 0;
    return b.weeklyRemainingToHard - a.weeklyRemainingToHard;
  });

  if (withReset.length === 0) return byRemaining[0]!;

  const chaseable = withReset.filter((c) => {
    const denom = c.weeklyHardCapTokens > 0 ? c.weeklyHardCapTokens : 1;
    const frac = c.weeklyRemainingToHard / denom;
    return frac >= MIN_REMAINING_FRAC_TO_CHASE_SOONER && c.rolling5hRemainingToHard > 0;
  });

  if (chaseable.length === 0) return byRemaining[0]!;

  const soonest = Math.min(...chaseable.map((c) => c.weeklyNextResetTs as number));
  const soonestGroup = chaseable.filter((c) => c.weeklyNextResetTs === soonest);

  const sorted = soonestGroup.sort((a, b) => {
    if (a.state !== b.state) return a.state === "ok" ? -1 : b.state === "ok" ? 1 : 0;
    return b.weeklyRemainingToHard - a.weeklyRemainingToHard;
  });

  const best = sorted[0]!;
  if (lastAutoChoice?.profile === best.name) return best;

  // If we're already very close to switching, don't flap.
  if (lastAutoChoice && now - lastAutoChoice.chosenAt < MIN_SWITCH_INTERVAL_MS) {
    const prev = pool.find((c) => c.name === lastAutoChoice?.profile);
    if (prev && prev.state !== "hard") return prev;
  }

  return best;
}

export async function resolveAutoOpencodeProfileName(
  now: number = Date.now(),
  opts?: ThrottleDecisionProvider
): Promise<string | null> {
  const throttle = opts?.getThrottleDecision ?? getThrottleDecision;
  const profiles = listOpencodeProfileNames();
  if (profiles.length === 0) return null;

  const decisions = await Promise.all(
    profiles.map(async (name) => ({ name, decision: await throttle(now, { opencodeProfile: name }) }))
  );

  const candidates = decisions.map(({ name, decision }) => toCandidate(name, decision));
  const best = chooseBest(candidates, now);

  if (best?.name) {
    if (!lastAutoChoice || lastAutoChoice.profile !== best.name) {
      lastAutoChoice = { profile: best.name, chosenAt: now };
    }
    return best.name;
  }

  return null;
}

export type OpencodeProfileSelectionSource = "requested" | "auto" | "failover";

export type ResolvedOpencodeProfileForNewWork = {
  profileName: string | null;
  decision: ThrottleDecision;
  source: OpencodeProfileSelectionSource;
  requestedProfile: string | null;
};

/**
 * Pick an OpenCode profile for starting new work.
 *
 * - If requested is "auto", uses the auto selector.
 * - Otherwise, uses the requested/default profile unless it is hard-throttled.
 * - If the requested/default profile is hard-throttled, attempts a best-effort failover
 *   to another configured profile.
 *
 * This is safe for *new sessions* only. Do not use it when resuming an existing session.
 */
export async function resolveOpencodeProfileForNewWork(
  now: number = Date.now(),
  requestedProfile: string | null = null,
  opts?: ThrottleDecisionProvider
): Promise<ResolvedOpencodeProfileForNewWork> {
  const throttle = opts?.getThrottleDecision ?? getThrottleDecision;
  const requested = (requestedProfile ?? "").trim();

  if (requested === "auto") {
    const chosen = await resolveAutoOpencodeProfileName(now, opts);
    const decision = await throttle(now, { opencodeProfile: chosen });

    return {
      profileName: decision.snapshot.opencodeProfile ?? null,
      decision,
      source: "auto",
      requestedProfile: "auto",
    };
  }

  const baseDecision = await throttle(now, { opencodeProfile: requested ? requested : null });
  if (baseDecision.state !== "hard") {
    return {
      profileName: baseDecision.snapshot.opencodeProfile ?? null,
      decision: baseDecision,
      source: "requested",
      requestedProfile: requested ? requested : null,
    };
  }

  const effectiveProfile = baseDecision.snapshot.opencodeProfile ?? null;
  if (!effectiveProfile) {
    return {
      profileName: null,
      decision: baseDecision,
      source: "requested",
      requestedProfile: requested ? requested : null,
    };
  }

  const profiles = listOpencodeProfileNames();
  if (profiles.length < 2) {
    return {
      profileName: baseDecision.snapshot.opencodeProfile ?? null,
      decision: baseDecision,
      source: "requested",
      requestedProfile: requested ? requested : null,
    };
  }

  const chosen = await resolveAutoOpencodeProfileName(now, opts);
  if (!chosen) {
    return {
      profileName: baseDecision.snapshot.opencodeProfile ?? null,
      decision: baseDecision,
      source: "requested",
      requestedProfile: requested ? requested : null,
    };
  }

  const failoverDecision = await throttle(now, { opencodeProfile: chosen });
  if (failoverDecision.state === "hard") {
    return {
      profileName: baseDecision.snapshot.opencodeProfile ?? null,
      decision: baseDecision,
      source: "requested",
      requestedProfile: requested ? requested : null,
    };
  }

  return {
    profileName: failoverDecision.snapshot.opencodeProfile ?? null,
    decision: failoverDecision,
    source: "failover",
    requestedProfile: requested ? requested : null,
  };
}

export function __resetAutoOpencodeProfileSelectionForTests(): void {
  lastAutoChoice = null;
}
