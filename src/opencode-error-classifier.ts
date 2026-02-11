import type { BlockedSource } from "./blocked-sources";

export type OpencodeFailureClassification = {
  code: "config-invalid" | "permission-denied" | "profile-unresolvable";
  blockedSource: BlockedSource;
  reason: string;
  capability?: string;
  target?: string;
};

export function classifyOpencodeFailure(text: string | null | undefined): OpencodeFailureClassification | null {
  const output = (text ?? "").trim();
  if (!output) return null;

  const unresolvableMatch = /blocked:profile-unresolvable:\s*([^\n]+)/i.exec(output);
  if (unresolvableMatch) {
    const reason = unresolvableMatch[0].trim();
    return {
      code: "profile-unresolvable",
      blockedSource: "profile-unresolvable",
      reason,
    };
  }

  const permissionWithTarget = /permission requested:\s*([a-z0-9_.-]+)\s*\(([^\n)]+)\)\s*;\s*auto-rejecting/i.exec(output);
  if (permissionWithTarget) {
    const capability = permissionWithTarget[1]?.trim() || "unknown";
    const target = permissionWithTarget[2]?.trim() || "unknown";
    return {
      code: "permission-denied",
      blockedSource: "permission",
      reason: `blocked:permission: OpenCode sandbox denied ${capability} (${target}).`,
      capability,
      target,
    };
  }

  const permissionWithoutTarget = /permission requested:\s*([a-z0-9_.-]+)[^\n]*auto-rejecting/i.exec(output);
  if (permissionWithoutTarget) {
    const capability = permissionWithoutTarget[1]?.trim() || "unknown";
    return {
      code: "permission-denied",
      blockedSource: "permission",
      reason: `blocked:permission: OpenCode sandbox denied ${capability}.`,
      capability,
    };
  }

  const invalidFunctionSchema = /Invalid schema for function\s+'([^']+)'/i.exec(output);
  const hasInvalidFunctionParameters = /invalid_function_parameters/i.test(output);
  if (!invalidFunctionSchema && !hasInvalidFunctionParameters) return null;

  const toolName = invalidFunctionSchema?.[1]?.trim();
  const toolLabel = toolName ? ` for tool '${toolName}'` : "";
  return {
    code: "config-invalid",
    blockedSource: "opencode-config-invalid",
    reason: `OpenCode config invalid: tool schema rejected${toolLabel} (invalid_function_parameters).`,
  };
}
