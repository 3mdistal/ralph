type ParentVerificationPromptOptions = {
  repo: string;
  issueNumber: string | number;
  issueContext?: string | null;
};

export function buildParentVerificationPrompt(options: ParentVerificationPromptOptions): string {
  const issueNumber = String(options.issueNumber).trim();
  const repo = options.repo.trim();
  const issueContext = String(options.issueContext ?? "").trim();

  return [
    "Parent verification prompt v1",
    "",
    `I need to verify whether task #${issueNumber} in ${repo} still requires implementation work.`,
    "",
    "IMPORTANT: This runs in a non-interactive daemon. Do NOT ask questions. If you would normally ask a question, make a reasonable default choice and proceed, stating any assumptions briefly.",
    "",
    "Steps:",
    "1) Review the GitHub issue context below (prefetched by the orchestrator when possible).",
    issueContext ? "---" : null,
    issueContext ? issueContext : null,
    issueContext ? "---" : null,
    "",
    "If issue context is missing/unavailable, fetch it via REST (avoid `gh issue view`, which uses GraphQL):",
    "```bash",
    `gh api repos/${repo}/issues/${issueNumber}`,
    `gh api repos/${repo}/issues/${issueNumber}/comments --paginate`,
    "```",
    "3) Decide if any implementation work remains given the issue description, current dependency state, and latest comments.",
    "",
    "Decision guidance:",
    "- If the issue is clearly resolved or no actionable work remains, set work_remains=false and explain why.",
    "- If there is any reasonable remaining work, set work_remains=true and summarize what remains.",
    "- Keep the reason short and deterministic (1-2 sentences).",
    "- When work_remains=false, include confidence, checked, why_satisfied, and evidence so Ralph can decide whether to auto-complete safely.",
    "",
    "Output requirements:",
    "- Your final line MUST be the marker below, with valid JSON (no code fences).",
    "- Use version 1.",
    "",
    "Format:",
    "RALPH_PARENT_VERIFY: {\"version\":1,\"work_remains\":true|false,\"reason\":\"...\",\"confidence\":\"low|medium|high\",\"checked\":[\"...\"],\"why_satisfied\":\"...\",\"evidence\":[{\"url\":\"https://...\",\"note\":\"...\"}]}",
  ].join("\n");
}
