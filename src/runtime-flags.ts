export type RuntimeFlagParseResult = {
  args: string[];
  profileOverride: "prod" | "sandbox" | null;
  sandboxRunId: string | null;
};

export function parseGlobalRuntimeFlags(argv: string[]): RuntimeFlagParseResult {
  let profileOverride: "prod" | "sandbox" | null = null;
  let sandboxRunId: string | null = null;
  let i = 0;

  while (i < argv.length) {
    const token = argv[i] ?? "";

    if (token === "--profile" || token.startsWith("--profile=")) {
      const value = token === "--profile" ? argv[i + 1] ?? "" : token.slice("--profile=".length);
      const profile = value.trim();
      if (!profile) {
        throw new Error("[ralph] --profile requires a value (prod|sandbox).");
      }
      if (profile !== "prod" && profile !== "sandbox") {
        throw new Error(`[ralph] Invalid --profile=${JSON.stringify(profile)}; expected \"prod\" or \"sandbox\".`);
      }
      profileOverride = profile;
      i += token === "--profile" ? 2 : 1;
      continue;
    }

    if (token === "--run-id" || token.startsWith("--run-id=")) {
      const value = token === "--run-id" ? argv[i + 1] ?? "" : token.slice("--run-id=".length);
      const runId = value.trim();
      if (!runId) {
        throw new Error("[ralph] --run-id requires a non-empty value.");
      }
      sandboxRunId = runId;
      i += token === "--run-id" ? 2 : 1;
      continue;
    }

    break;
  }

  return {
    args: argv.slice(i),
    profileOverride,
    sandboxRunId,
  };
}
