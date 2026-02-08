# Parent verification lane

Status: non-canonical (lane spec)
Owner: @3mdistal
Last updated: 2026-02-01

When dependency or sub-issue blockers clear, queued parent issues can be runnable but already satisfied. The parent verification lane is a lightweight pre-implementation check that confirms whether any work remains before entering the full plan/build pipeline.

## Trigger (deterministic)

Run parent verification when dependency/sub-issue blockers clear for a parent issue and the issue is queued/runnable.

Dependency detection uses GitHub-native relationships only (no issue-body parsing).

## Ordering

If an issue has a mergeable open PR that already closes the issue, reconcile that first. Only run parent verification when no mergeable PR resolves the issue.

## Output contract

The verifier must emit a last-line marker:

`RALPH_PARENT_VERIFY: {"version":1,"work_remains":true|false,"reason":"...","confidence":"low|medium|high","checked":["..."],"why_satisfied":"...","evidence":[{"url":"https://...","note":"..."}]}`

Marker notes:

- `confidence`, `checked`, `why_satisfied`, and `evidence` are required for comment-only auto-completion when `work_remains=false`.
- Backward-compatible markers that omit these keys are valid parse output, but they are not eligible for auto-close.

## Outcomes

- `work_remains=true`: record outcome and proceed to the normal implementation pipeline.
- `work_remains=false`: record outcome and either:
  - complete via comment-only path when confidence/evidence are strong:
    - post or edit one verification comment using marker `<!-- ralph-verify:v1 id=ISSUE_NUMBER -->`
    - include `RALPH_VERIFY: {"version":1,"work_remains":false,"confidence":"medium|high","checked":[...],"why_satisfied":"...","evidence":[{"url":"...","note":"..."}]}`
    - set `ralph:status:done` and close the issue (no PR), or
  - escalate with a "close or clarify" summary when confidence is low/unknown or evidence is weak.

## Failure handling

- Bounded attempts with backoff.
- After max attempts, record `skipped` and proceed to implementation (verification is a non-blocking optimization).
- Degraded mode (label writes/reads unavailable) must not block the lane.

When proceeding after a failed/inconclusive parent verification, seed the implementation context with:

- the list of relevant child issues (and their done/satisfied state)
- links to any child PRs or rollups
- a short statement: "parent verification was inconclusive; verify acceptance criteria against child evidence"
