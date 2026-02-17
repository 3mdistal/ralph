import type { RepoPreflightPolicyResolution } from "../config";

export type PrCreatePreflightDecision =
  | {
      action: "run";
      commands: string[];
      source: "preflightCommand" | "verification.preflight";
    }
  | {
      action: "skip";
      commands: [];
      source: "preflightCommand";
      skipReason: string;
    }
  | {
      action: "fail";
      commands: [];
      source: "preflightCommand" | "verification.preflight" | "none";
      reason: string;
      remediation: string;
    };

const PREFLIGHT_REMEDIATION =
  "Configure repos[].preflightCommand in Ralph config (string or string[]), " +
  "or explicitly disable preflight with repos[].preflightCommand=[]. " +
  "See docs/product/deterministic-gates.md.";

export function decidePreflightForPrCreate(params: {
  repoName: string;
  resolution: RepoPreflightPolicyResolution;
}): PrCreatePreflightDecision {
  const { resolution } = params;
  if (resolution.kind === "run") {
    return {
      action: "run",
      commands: resolution.commands,
      source: resolution.source,
    };
  }

  if (resolution.kind === "disabled") {
    return {
      action: "skip",
      commands: [],
      source: "preflightCommand",
      skipReason: "preflight disabled (preflightCommand=[])",
    };
  }

  if (resolution.kind === "misconfigured") {
    return {
      action: "fail",
      commands: [],
      source: resolution.source,
      reason: `Preflight is misconfigured for ${params.repoName}: ${resolution.reason}`,
      remediation: PREFLIGHT_REMEDIATION,
    };
  }

  return {
    action: "fail",
    commands: [],
    source: "none",
    reason: `Preflight is required before PR creation for ${params.repoName}: ${resolution.reason}`,
    remediation: PREFLIGHT_REMEDIATION,
  };
}
