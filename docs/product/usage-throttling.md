# Ralph: Usage throttling policy

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

### Pacing

Throttle decisions should pace usage toward the next reset time, rather than distributing evenly from window start.

### Resumption

When throttled, the system should compute and surface a best-effort `resumeAt` time based on reset schedules and current usage.

## Integration requirements

- Gate model sends at all major send points:
  - before `/next-task`
  - before each `continueSession(...)`
  - before merge/survey steps
- Store a durable throttle snapshot when entering throttled states (reason, window(s), used %, caps, reset times).
- Ensure “stop starting new tasks” composes with drain mode and does not interrupt in-flight work unless hard-throttled.

## Implementation notes

See `docs/ops/opencode-usage-throttling.md` for current implementation details and calibration notes for the current provider/tooling.