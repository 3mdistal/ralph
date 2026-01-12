import { listOpencodeProfileNames } from "./config";
import { getThrottleDecision } from "./throttle";

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

export async function resolveAutoOpencodeProfileName(now: number = Date.now()): Promise<string | null> {
  const profiles = listOpencodeProfileNames();
  if (profiles.length === 0) return null;

  const decisions = await Promise.all(
    profiles.map(async (name) => ({ name, decision: await getThrottleDecision(now, { opencodeProfile: name }) }))
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

export function __resetAutoOpencodeProfileSelectionForTests(): void {
  lastAutoChoice = null;
}
