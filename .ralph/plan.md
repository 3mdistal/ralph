# Plan: Issue #605 - `ralphctl doctor` (stale discovery/control repair)

Assumptions (non-interactive default choices):

- `ralphctl doctor` is safe-by-default (read-only) and only mutates state under an explicit `--repair` flag.
- Root resolution is resolver-driven (no hardcoded root lists): consume candidate resolvers from `src/control-root.ts`, `src/daemon-record.ts`, and `src/drain.ts`.
- Repairs are non-destructive + idempotent: rename/quarantine (never delete) and additive canonical writes; never kill processes.
- Audit mode must not call helpers that mutate state (avoid `discoverDaemon({ healStale: true })` in doctor).

## Contract (v1)

- Exit codes:
- `0`: `overall_status="ok"` (no operator action required)
- `1`: `overall_status in {"warn","error"}` (findings present), including partial/failed repairs
- `2`: usage/invalid args

- JSON output (additive-only evolution within `schema_version=1`):
- Required top-level: `schema_version: 1`, `timestamp`, `overall_status: "ok"|"warn"|"error"`, `ok: boolean`
- Required arrays: `daemon_candidates[]`, `control_candidates[]`, `roots[]`, `findings[]`, `recommended_repairs[]`, `applied_repairs[]`
- Findings/repairs must have stable identifiers: `code` (enum-like string) and `id` (stable action id). Human text is non-contractual.

## Implementation checklist

- [x] Inspect current discovery + control candidate resolvers used by `ralphctl` (`src/daemon-discovery.ts`, `src/daemon-record.ts`, `src/control-root.ts`, `src/drain.ts`).
- [x] Add `doctor` subcommand to `src/ralphctl.ts` (help text + flags: `--json`, `--repair`, optional `--dry-run`).
- [x] Implement doctor with a strict core/shell split:
- [x] `src/doctor/core.ts` (pure): convert a scanned snapshot into `findings[]`, `recommended_repairs[]`, and `overall_status`.
- [x] `src/doctor/io.ts` (impure): read filesystem + probe PIDs and build the snapshot (inject `now()` and `pidProbe`).
- [x] `src/doctor/repair.ts` (impure): execute selected safe repairs and return `applied_repairs[]`.
- [x] `src/doctor/render.ts` (pure): human-readable formatting and JSON serialization.
- [x] Audit coverage (pure core):
- [x] Daemon record candidates: exists/parseable/schema + PID liveness + best-effort identity check; classify `missing|stale|live|conflict|unreadable`.
- [x] Control file candidates: exists/parseable + summarize key state (`mode`, `pause_requested`, `pause_at_checkpoint`, `drain_timeout_ms`); flag mismatches.
- [x] Cross-link checks: daemon record `controlFilePath` exists/parseable; canonical-vs-legacy mismatches.
- [x] Known-root summary: group observed artifacts by root directory path (derived from candidates).
- [x] Repair execution safety gates:
- [x] Never mutate a record/control file referenced by a live daemon unless identity confidence is high.
- [x] Double-check liveness immediately before any rename/write (race/PID reuse mitigation).
- [ ] Use registry lock semantics where available; if needed, add a small exported lock helper in `src/daemon-record.ts` for doctor use.
- [x] Safe repairs under `--repair`:
- [x] Quarantine stale daemon record files via rename to `.stale-<ts>-<pid>` (only when PID is not alive on both checks).
- [x] Promote a live legacy daemon record into the canonical registry path (canonical-only write; do not delete/rename source).
- [x] Quarantine corrupt/unreadable daemon record files via rename to `.corrupt-<ts>-<pid>` when not referenced by a live daemon.
- [ ] (Optional, gated) Create canonical `control.json` only if *no* readable control file exists anywhere; default `{version:1, mode:"running"}`.
- [x] Tests:
- [x] Core table-driven tests for findings + recommended repairs from synthetic snapshots (no filesystem, no timers).
- [x] IO/repair tests with temp dirs and injected `now()`/`pidProbe` to make rename suffixes deterministic and simulate liveness races.
- [x] Contract tests: JSON v1 required fields/enums + exit-code matrix (healthy, warn/error, usage, repair success/partial).
- [ ] CLI integration tests: `ralphctl doctor` and `ralphctl doctor --json` under temp HOME/XDG; keep human assertions minimal, JSON assertions strict.
- [x] Docs: update `README.md` to include `ralphctl doctor`, flags, exit codes, and the v1 JSON contract (additive-only rule).
- [x] Run deterministic gates locally: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.
- [ ] Prepare PR targeting `bot/integration` with example outputs (`doctor` + `doctor --json`) and a note about safety defaults.
