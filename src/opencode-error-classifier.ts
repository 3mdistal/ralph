import type { BlockedSource } from "./blocked-sources";

export type OpencodeFailureClassification = {
  blockedSource: BlockedSource;
  reason: string;
};

export function classifyOpencodeFailure(text: string | null | undefined): OpencodeFailureClassification | null {
  const output = (text ?? "").trim();
  if (!output) return null;

  const hasExternalDirectoryPermission = /permission requested:\s*external_directory/i.test(output);
  const hasAutoRejecting = /auto-rejecting/i.test(output);
  if (hasExternalDirectoryPermission && hasAutoRejecting) {
    return {
      blockedSource: "permission",
      reason: "OpenCode sandbox permission denied: external_directory access blocked.",
    };
  }

  const invalidFunctionSchema = /Invalid schema for function\s+'([^']+)'/i.exec(output);
  const hasInvalidFunctionParameters = /invalid_function_parameters/i.test(output);
  if (!invalidFunctionSchema && !hasInvalidFunctionParameters) return null;

  const toolName = invalidFunctionSchema?.[1]?.trim();
  const toolLabel = toolName ? ` for tool '${toolName}'` : "";
  return {
    blockedSource: "opencode-config-invalid",
    reason: `OpenCode config invalid: tool schema rejected${toolLabel} (invalid_function_parameters).`,
  };
}
