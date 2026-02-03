# Ralph: OpenCode usage throttling (Codex 5h + weekly)

Status: non-canonical (implementation notes)
Owner: @3mdistal
Last updated: 2026-02-01
Canonical policy: `docs/product/usage-throttling.md` (this doc is implementation notes + calibration)

## Goal
Ensure Ralph never consumes more than a configurable fraction of the operator's available plan usage, while preserving predictable availability for interactive use.

- Track usage from OpenCode local logs (covers Ralph + any OpenCode chats).
- Enforce soft/hard thresholds (e.g., 65% / 75%).
- Add pacing so usage stays smooth and I don’t hit the wall suddenly.

## Key Constraints
- No official stable API to query Codex plan remaining percent/reset times; remote meters are best-effort and may fail.
- We can treat plan limits as constants after a one-time calibration when relying on local logs.
- Weekly + 5-hour windows must both be respected.

## Usage Source Precedence (OpenAI)

Ralph can use remote usage meters for OpenAI when enabled and falls back to local OpenCode logs when remote usage is unavailable or fails.

- Default: `openaiSource=remoteUsage`.
- If `openaiSource=remoteUsage`, attempt remote usage meters and fall back to `localLogs` on failure.
- If `openaiSource=localLogs`, never attempt remote usage.

## Data Source (Meters + Fallback)

### Remote meters (preferred for OpenAI)

- Uses OpenAI remote usage meters (best-effort) when `openaiSource=remoteUsage`.
- Remote usage provides per-window `usedPct` and `resetAt` values for rolling 5h + weekly.
- OAuth tokens are read from `XDG_DATA_HOME/opencode/auth.json`; refreshed tokens are written back atomically with `auth.json.bak` as a backup and never logged.

### Local logs (fallback)

OpenCode stores per-message usage locally; Ralph sums usage in rolling windows by timestamp.

- Location (macOS): `~/.local/share/opencode/storage/message/**/msg_*.json`
- Relevant fields: `providerID`, `role`, `time.created`, `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read/write`
- For matching the Codex dashboard, count only OpenAI-provider usage: `providerID == "openai"`.

## Calibration (One-Time)
We infer “100% budget” from dashboard percent and OpenCode logs.

### Assumption that matched best
Codex dashboard usage ≈ `tokens.input + tokens.output + tokens.reasoning` (cache tokens appear to not contribute to the dashboard meter, or contribute negligibly).

### Snapshots used
(Reset times: 5h resets at 11:50 AM; weekly resets Jan 15 7:09 PM)

- 10:10 AM: 5h remaining 34% (used 66%); weekly remaining 70% (used 30%).
- 10:30 AM: 5h remaining 30% (used 70%); weekly remaining 69% (used 31%).
- 11:50 AM: 5h remaining 19% (used 81%); weekly remaining 65% (used 35%).

From OpenCode logs (OpenAI provider only):
- 10:10 AM: `tokens5h=11,222,689`, `tokensWeek=16,688,613`
- 10:30 AM: `tokens5h=11,878,969`, `tokensWeek=17,332,069`
- 11:50 AM: `tokens5h=13,732,769`, `tokensWeek=19,185,869`

### Inferred constants (treat as “plan limits”)
Compute `budget = tokens_used / used_fraction`.

- 5-hour budget (effective units): ~`16,954,036` tokens / 5h
- Weekly budget (effective units): ~`54,816,769` tokens / week

(These are consistent with the earlier 10:10/10:30 estimates; if drift becomes noticeable, re-calibrate with 2 timestamped screenshots.)

### 11:50 AM confirmation
Using the earlier constants, predicted remaining was ~19.2% (5h) and ~65.6% (weekly), which matches the dashboard closely.

## Throttling Policy
Two thresholds, plus pacing:

- Soft threshold (default 65%): pause starting new tasks; allow in-flight tasks to continue if they will not push us into hard.
- Hard threshold (default 75%): pause ALL OpenCode sending (including continuing in-progress tasks).
- Pacing: continuously rate-limit so we are unlikely to reach the threshold before reset.

## Layered Windows (5h + Weekly)
Maintain two independent “budget buckets”. Ralph must satisfy BOTH.

- 5h bucket protects “I can still use OpenCode personally today”.
- Weekly bucket protects “predictable week-long consumption”.

## Pacing Algorithm (Predictability)
Use “pace to reset” rather than “spread evenly from window start”.

For each window `w`:
- `budget_w` = inferred constant
- `softCap_w = softPct * budget_w`
- `hardCap_w = hardPct * budget_w`
- `used_w` = sum of `tokens.input+output+reasoning` for OpenAI provider within rolling window
- `timeLeft_w = resetAt_w - now`

Hard stop:
- If `used_w >= hardCap_w` for either window → hard throttle.

Soft stop:
- If `used_w >= softCap_w` for either window → soft throttle (don’t start new tasks).

Pacing:
- `remainingToSoft_w = max(0, softCap_w - used_w)`
- `allowedRate_w = remainingToSoft_w / max(1, timeLeft_w)`
- Apply effective rate = `min(allowedRate_5h, allowedRate_week)`.

Operationally, this becomes: “before each new OpenCode message Ralph wants to send, check if we have enough ‘token headroom’ given the time left until reset; if not, pause.”

## Ralph UX / Queue Integration
Add an explicit queue state and resume metadata.

- New daemon mode: `soft-throttled` / `hard-throttled`
- Store: `throttledAt`, `resumeAt`, `throttleReason`, and a `usageSnapshot` (used %, caps, reset times) in SQLite

Behavior:
- Soft throttle: don’t start new tasks; keep queued tasks queued.
- Hard throttle: stop all model sends; in-progress tasks pause only at safe checkpoints.

## Config Surface
Add a throttle config section to Ralph:

- `throttle.enabled`
- `throttle.providerID` (default `openai`)
- `throttle.openaiSource` (`localLogs` | `remoteUsage`, default `localLogs`; OpenAI-only)
- `throttle.windows.rolling5h.budgetTokens` (default 16,987,015)
- `throttle.windows.weekly.budgetTokens` (default 55,769,305)
- `throttle.softPct` (default 0.65)
- `throttle.hardPct` (default 0.75)
- `throttle.reservePct5h` (optional, extra protection for personal usage)
- `throttle.minCheckIntervalMs` (avoid scanning logs too frequently)
- `throttle.perProfile.<profile>` (optional): override `enabled`, `providerID`, `softPct`, `hardPct`, `minCheckIntervalMs`, and window budgets for a specific OpenCode profile

## Implementation Plan (High-Level)
1) Add usage reader
- Implement a small module that scans `~/.local/share/opencode/storage/message` and sums tokens by window.
- Filter strictly to `providerID=="openai"` and `role=="assistant"`.

2) Add throttling decision engine
- Given budgets, thresholds, and reset timestamps, compute soft/hard throttle decisions + `resumeAt`.

3) Integrate with queue
- Add `throttled` status and persistence fields.
- Ensure in-flight tasks can be paused safely and resumed later.

4) Gate OpenCode sends
- Before planning, before each “Continue.”, and before merge/survey steps: check throttle.

5) Add observability
- Log a structured snapshot when entering/leaving throttled state.
- Add a small summary line in `queue.json` / run logs so it’s obvious why work stopped.
- Add a CLI view of the current meters: `ralph usage` (table) and `ralph usage --json`.

Notes:
- When using `throttle.openaiSource = "remoteUsage"`, remote usage is cached in-process for ~2 minutes per OpenCode auth file (deduped across concurrent requests).

6) Add a `calibrate` helper (optional but valuable)
- A CLI command that takes two timestamped dashboard snapshots (5h/week % + reset times) and computes budgets automatically from OpenCode logs.

## Nice-to-Haves
- Tag Ralph-originated OpenCode sessions with a distinct agent name (e.g., `agent="ralph"`) so we can separately visualize “Ralph spend” vs “everything else”, even if the throttle is based on total.
- Track non-OpenAI providers (GLM, Anthropic, etc.) in parallel for cost dashboards, even if they don’t affect Codex plan limits.

## Open Questions
- Do we want separate budgets per OpenAI model family (codex vs mini), or keep the single blended token budget (simpler)?
- Should we keep soft throttle permissive (let in-flight finish), or aggressively pause as soon as we hit soft to preserve personal headroom?
