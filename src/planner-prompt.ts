type PlannerPromptOptions = {
  repo: string;
  issueNumber: string | number;
  issueContext?: string | null;
};

export function buildPlannerPrompt(options: PlannerPromptOptions): string {
  const issueNumber = String(options.issueNumber).trim();
  const repo = options.repo.trim();
  const issueContext = String(options.issueContext ?? "").trim();

  return [
    "Planner prompt v1",
    "",
    `I need to work on task #${issueNumber} in ${repo}.`,
    "",
    "IMPORTANT: This runs in a non-interactive daemon. Do NOT ask the user questions. If you would normally ask a question, make a reasonable default choice and proceed, clearly stating any assumptions.",
    "If a 'Child completion dossier' section is present, verify whether the parent issue is already satisfied by child work before implementing. Do NOT redo child work.",
    "",
    "GitHub issue context is provided below (prefetched by the orchestrator when possible).",
    "Treat explicit decisions/policies in comments as authoritative product guidance.",
    "",
    issueContext ? "---" : null,
    issueContext ? issueContext : null,
    issueContext ? "---" : null,
    "",
    "If issue context is missing/unavailable, fetch it via REST (avoid `gh issue view`, which uses GraphQL):",
    "```bash",
    `gh api repos/${repo}/issues/${issueNumber}`,
    `gh api repos/${repo}/issues/${issueNumber}/comments --paginate`,
    "```",
    "",
    "Then, consult @product to get context on this task. Product should review the GitHub Issue (including comments) and relevant product docs, understand how it fits into the product vision, and explain:",
    "- Why this task matters",
    "- What success looks like from a product perspective",
    "- Any product considerations or constraints",
    "",
    "Once you have the product context, create a detailed implementation plan for the task.",
    "",
    "After you propose the plan, write/update the plan checklist in .ralph/plan.md in the repo worktree.",
    "- Use Markdown checkboxes.",
    "- Treat .ralph/plan.md as the source of truth for step tracking.",
    "- Update it as steps complete.",
    "",
    "Then, consult @devex **with the full plan you wrote**. Devex should review the plan for maintainability and execution risks, and suggest concrete improvements (especially around boundaries, testing strategy, and functional-core/imperative-shell separation).",
    "",
    "If devex feedback suggests changes, revise the plan accordingly.",
    "",
    "---",
    "",
    "**IMPORTANT: After creating the plan, you MUST output a routing decision as a JSON code block:**",
    "",
    "```json",
    "{",
    "  \"decision\": \"proceed\" | \"escalate\",",
    "  \"confidence\": \"high\" | \"medium\" | \"low\",",
    "  \"escalation_reason\": null | \"<reason if escalating>\"",
    "}",
    "```",
    "",
    "Routing rules:",
    "- Only identify a **PRODUCT GAP** if neither product docs nor issue comments contain the needed guidance",
    "- If @product identified a **PRODUCT GAP**, you MUST set decision to \"escalate\"",
    "- If confidence is \"low\" due to ambiguous requirements, set decision to \"escalate\"",
    "- If @devex identifies major maintainability risks or missing validation strategy, reduce confidence; if confidence becomes \"low\", set decision to \"escalate\"",
    "- If the plan is clear and @product approved (and @devex has no Must-fix concerns), set decision to \"proceed\" with confidence \"high\"",
    "- The orchestrator will parse this JSON to determine next steps",
  ].join("\n");
}
