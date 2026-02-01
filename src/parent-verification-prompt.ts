type ParentVerificationPromptOptions = {
  repo: string;
  issueNumber: string | number;
};

export function buildParentVerificationPrompt(options: ParentVerificationPromptOptions): string {
  const issueNumber = String(options.issueNumber).trim();
  const repo = options.repo.trim();

  return [
    "Parent verification prompt v1",
    "",
    `I need to verify whether task #${issueNumber} in ${repo} still requires implementation work.`,
    "",
    "IMPORTANT: This runs in a non-interactive daemon. Do NOT ask questions. If you would normally ask a question, make a reasonable default choice and proceed, stating any assumptions briefly.",
    "",
    "Steps:",
    "1) Read the GitHub issue body.",
    `2) Read the issue comments (use 'GH_PAGER=cat gh issue view ${issueNumber} --repo ${repo} --comments' to fetch the full thread; prioritize latest maintainer/owner comments).`,
    "3) Decide if any implementation work remains given the issue description, current dependency state, and latest comments.",
    "",
    "Decision guidance:",
    "- If the issue is clearly resolved or no actionable work remains, set work_remains=false and explain why.",
    "- If there is any reasonable remaining work, set work_remains=true and summarize what remains.",
    "- Keep the reason short and deterministic (1-2 sentences).",
    "",
    "Output requirements:",
    "- Your final line MUST be the marker below, with valid JSON (no code fences).",
    "- Use version 1.",
    "",
    "Format:",
    "RALPH_PARENT_VERIFY: {\"version\":1,\"work_remains\":true|false,\"reason\":\"...\"}",
  ].join("\n");
}
