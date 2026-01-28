export type SandboxAction = {
  repoFullName: string;
  action: "archive" | "delete" | "tag";
  reason?: string;
};

export type SandboxActionFailure = {
  action: SandboxAction;
  error: string;
};

function formatSandboxError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as any)?.code;
  if (code === "rate_limit") {
    return `${message} (GitHub rate limit hit; wait and retry or reduce --max.)`;
  }
  return message;
}

export async function executeSandboxActions(params: {
  actions: SandboxAction[];
  apply: boolean;
  execute: (action: SandboxAction) => Promise<void>;
  concurrency?: number;
}): Promise<{ executed: SandboxAction[]; skipped: SandboxAction[]; failed: SandboxActionFailure[] }>
{
  if (!params.apply) {
    return { executed: [], skipped: params.actions, failed: [] };
  }

  const executed: SandboxAction[] = [];
  const failed: SandboxActionFailure[] = [];
  const concurrency = Math.max(1, Math.floor(params.concurrency ?? 1));

  let index = 0;
  async function worker(): Promise<void> {
    while (true) {
      const current = index;
      index += 1;
      if (current >= params.actions.length) return;
      const action = params.actions[current] as SandboxAction;
      try {
        await params.execute(action);
        executed.push(action);
      } catch (err) {
        failed.push({ action, error: formatSandboxError(err) });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, params.actions.length) }, () => worker());
  await Promise.all(workers);

  return { executed, skipped: [], failed };
}
