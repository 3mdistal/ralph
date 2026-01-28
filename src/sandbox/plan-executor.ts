export type SandboxAction = {
  repoFullName: string;
  action: "archive" | "delete" | "tag";
  reason?: string;
};

export async function executeSandboxActions(params: {
  actions: SandboxAction[];
  apply: boolean;
  execute: (action: SandboxAction) => Promise<void>;
}): Promise<{ executed: SandboxAction[]; skipped: SandboxAction[] }>
{
  if (!params.apply) {
    return { executed: [], skipped: params.actions };
  }

  const executed: SandboxAction[] = [];
  for (const action of params.actions) {
    await params.execute(action);
    executed.push(action);
  }

  return { executed, skipped: [] };
}
