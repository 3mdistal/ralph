# Ralph: Usage throttling policy

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01
Related: `docs/product/vision.md`, `docs/ops/opencode-usage-throttling.md`, `docs/product/orchestration-contract.md`

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

### Usage source precedence (OpenAI)

When the effective provider is OpenAI, the usage source used for throttling **and** status must follow this precedence:

- Default: remote meters (`openaiSource=remoteUsage`).
- If remote usage is enabled but unavailable/fails, fall back to local OpenCode message-log scanning.
- If `openaiSource` is explicitly set to `localLogs`, do not attempt remote usage.
- Remote usage requires OAuth tokens from `XDG_DATA_HOME/opencode/auth.json`; refresh writeback is atomic with a backup and tokens are never logged.

### Status visibility

`bun run status` must reuse the same throttle snapshot logic and show per-profile usage for rolling 5h + weekly windows.

- When remote meters are used: show `source=remoteUsage`, `usedPct`, and `resetAt` for both windows.
- When falling back to local logs: show `source=localLogs`, `used/softCap/hardCap` tokens, and include `remoteUsageError` when present.
- If no local logs exist: degrade gracefully with “no data / 0 usage” (status must not fail).

#### Profile failover (new work)

Hard throttle is evaluated against the **effective** OpenCode profile used for that operation.

- For **starting new tasks** (starting a new OpenCode session), if the requested/default profile is hard-throttled and another configured profile is not, Ralph may **fail over** to that other profile so the daemon can continue making progress.
- For **in-flight work / resume**, Ralph does **not** attempt to switch profiles mid-session; if the session’s profile is hard-throttled, work pauses until `resumeAt`.

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
  - before the planner prompt
  - before each `continueSession(...)`
  - before merge/survey steps
- Store a durable throttle snapshot when entering throttled states (reason, window(s), used %, caps, reset times).
- Ensure “stop starting new tasks” composes with drain mode and does not interrupt in-flight work unless hard-throttled.

## Throttle persistence

When hard throttle triggers, Ralph persists throttling state at the task level so it is visible, explainable, and survives daemon restarts.

Throttle is a daemon-level condition. Do not add per-issue GitHub status labels for throttling.

- Persist a durable throttle snapshot in SQLite (computedAt, windows, resumeAt).
- `bun run status` surfaces current throttle state and `resumeAt`.
- In-flight tasks pause only at safe checkpoints; their GitHub status remains `ralph:status:in-progress` unless/until they escalate.

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
