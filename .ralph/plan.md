# Plan: #37 Dashboard edit endpoints (priority/status)

Assumptions (non-interactive defaults):
- “Status editing” in the dashboard means expressing operator intent via semantic commands that map to GitHub `ralph:cmd:*` labels (per `docs/product/orchestration-contract.md`), not directly setting `ralph:status:*` labels.
- bwrb is legacy output-only; do not add any new bwrb-dependent write paths for these endpoints.
- Control-plane “taskId” for GitHub-backed tasks is `github:OWNER/REPO#NUMBER` (existing convention in `src/index.ts`).

## Checklist

- [x] Review current control-plane API + existing `setTaskPriority` handler; confirm it already uses `ralph:priority:*` labels for GitHub tasks.
- [x] Add a GitHub-first “status intent” command to the control plane:
- [x] Extend `src/dashboard/control-plane-server.ts` with `POST /v1/commands/task/command`.
- [x] Request body: `{ "taskId": string, "command": "queue"|"pause"|"stop"|"satisfy", "comment"?: string }`.
- [x] Validate JSON + required fields; return `400` on missing/invalid `command`.
- [x] Add explicit error-to-HTTP mapping so handler validation failures return actionable `4xx` (not generic `500`).
- [x] Wire through a new handler on `ControlPlaneCommandHandlers` (e.g. `applyTaskCommand`).
- [x] Implement the daemon handler with good boundaries (avoid growing `src/index.ts`):
- [x] Extract a focused module (e.g. `src/dashboard/task-command.ts`) that:
- [x] Parses and validates `taskId` (must be `github:OWNER/REPO#NUMBER`).
- [x] Validates the command enum and maps it to a `ralph:cmd:*` label internally.
- [x] Enforces a repo allowlist (must be in configured `config.repos`).
- [x] Produces an “effect plan” for GitHub writes (labels + optional comment) that the imperative shell executes.
- [x] Execute the plan using `ensureRalphWorkflowLabelsOnce` + `executeIssueLabelOps` + GitHub REST comment write.
- [x] Emit a `log.ralph` dashboard event describing the applied command (do not log raw comment text).
- [x] Add dashboard client API convenience (optional but low-cost): add a function in `src/dashboard/client/api.ts` to call `/v1/commands/task/command`.
- [x] Tests:
- [x] Update `src/__tests__/control-plane-server.test.ts` to cover the new route (auth + validation + handler called with parsed fields).
- [x] Add unit tests for the new parser/validator module (`taskId` parsing, command mapping, repo allowlist, error mapping).
- [x] Run the dashboard/control-plane test suite (`bun test`) and ensure no new bwrb-write behavior was introduced.
