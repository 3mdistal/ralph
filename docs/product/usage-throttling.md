# Ralph: Usage throttling policy

**Status:** draft (policy)
**Owner:** @3mdistal
**Last updated:** 2026-01-10
**Related:** `docs/product/vision.md`, `docs/ops/opencode-usage-throttling.md`

## Summary

Ralph must protect operator reliability by preventing runaway background agent usage from consuming all available model budget.

This is a product-level policy: the system should self-regulate to preserve predictable availability and reduce surprise “hard stop” incidents.

## Goals

- Preserve predictable availability for interactive/primary operator usage.
- Avoid sudden budget exhaustion by pacing toward resets.
- Make throttling visible and explainable in logs/status.
- Avoid increasing escalation rate; throttling should be automatic and low-interrupt.

## Non-goals

- Perfect accounting across providers/models.
- A vendor-specific billing integration (until one exists).

## Policy

### Two-tier throttle

- **Soft throttle**: stop *starting new tasks* (do not schedule/dequeue new work).
- **Hard throttle**: stop *all* model sends (including continuing in-flight tasks).

### Layered windows

Support multiple windows simultaneously (e.g., a short rolling window and a weekly window). The effective throttle state is the most restrictive state across windows.

### Per-profile overrides

When using multiple OpenCode profiles (multi-account), Ralph may apply throttle settings per profile (budgets/thresholds/provider). Overrides are selected based on the effective OpenCode profile used for the operation (i.e., the profile whose local OpenCode logs are scanned and whose account would be charged).

When no effective profile is known, Ralph should fall back to global throttle settings.

### Pacing

Throttle decisions should pace usage toward the next reset time, rather than distributing evenly from window start.

### Resumption

When throttled, the system should compute and surface a best-effort `resumeAt` time based on reset schedules and current usage.

### Enforcement timing

Hard throttle is enforced at safe checkpoints (control boundaries), not by interrupting an in-flight model send.

- If a model send is already in progress, it may complete.
- Ralph must not initiate any *new* model sends once hard throttle is detected.
- In practice, this means gating sends *before* they happen and pausing tasks at the next safe checkpoint (e.g., between `continueSession(...)` calls).

## Integration requirements

- Gate model sends at all major send points:
  - before `/next-task`
  - before each `continueSession(...)`
  - before merge/survey steps
- Store a durable throttle snapshot when entering throttled states (reason, window(s), used %, caps, reset times).
- Ensure “stop starting new tasks” composes with drain mode and does not interrupt in-flight work unless hard-throttled.

## Throttle persistence

When hard throttle triggers, Ralph persists throttling state at the task level so it is visible, explainable, and survives daemon restarts.

### Task status + fields

- Set task `status: throttled`.
- Persist the following frontmatter fields (string-typed):
  - `throttled-at`: ISO timestamp when Ralph paused the task.
  - `resume-at`: ISO timestamp when Ralph expects it is safe to resume (best-effort).
  - `usage-snapshot`: JSON string describing the throttle decision.

### Snapshot schema (best-effort)

`usage-snapshot` is a JSON object that SHOULD include:
- `computedAt` (ISO timestamp)
- `providerID` (e.g. `openai`)
- `opencodeProfile` (string or null; best-effort)
- `messagesRootDir` (string; best-effort)
- `state` (`ok` | `soft` | `hard`)
- `resumeAt` (ISO timestamp or null)
- `windows`: array of per-window objects including:
  - `name`, `windowMs`, `budgetTokens`, `softCapTokens`, `hardCapTokens`, `usedTokens`, `usedPct`
  - `oldestTsInWindow`, `resumeAtTs`

Ralph may include additional keys for observability, but should keep these core fields stable.

## Implementation notes

See `docs/ops/opencode-usage-throttling.md` for current implementation details and calibration notes for the current provider/tooling.
