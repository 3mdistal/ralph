import type { RepoPreflightCommands } from "../config";

export type PreflightPolicyDecision =
  | {
      action: "block";
      causeCode: "POLICY_DENIED";
      diagnostics: string[];
    }
  | {
      action: "run";
      commands: string[];
      skipReason: string;
      diagnostics: string[];
    };

export function evaluatePreflightPolicy(config: RepoPreflightCommands): PreflightPolicyDecision {
  if (config.invalid) {
    return {
      action: "block",
      causeCode: "POLICY_DENIED",
      diagnostics: [
        "- Preflight config is invalid; refusing to create PR",
        `- Source: ${config.source}`,
        "- Expected: preflightCommand as string|string[] (or verification.preflight as string[])",
      ],
    };
  }

  if (!config.configured) {
    return {
      action: "block",
      causeCode: "POLICY_DENIED",
      diagnostics: [
        "- Preflight is not configured; refusing to create PR",
        "- Configure repos[].preflightCommand (set [] only to explicitly disable preflight)",
      ],
    };
  }

  if (config.source === "verification.preflight" && config.commands.length === 0) {
    return {
      action: "block",
      causeCode: "POLICY_DENIED",
      diagnostics: [
        "- verification.preflight is empty; refusing to create PR",
        "- Use repos[].preflightCommand=[] to explicitly disable preflight",
      ],
    };
  }

  const skipReason =
    config.source === "preflightCommand" && config.commands.length === 0
      ? "preflight disabled (preflightCommand=[])"
      : "preflight configured but empty";

  return {
    action: "run",
    commands: config.commands,
    skipReason,
    diagnostics: [],
  };
}
