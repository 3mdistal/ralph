# Plan: Issue #610 - Profiles fail-closed + shared managed config semantics

Assumptions (non-interactive defaults):
- Dependency `3mdistal/ralph#608` will land first; this work is implemented/rebased on top of it.
- "Fail closed" means: when `opencode.enabled=true`, *both* start and resume must not proceed if a profile cannot be deterministically resolved; no ambient XDG fallback.

## Checklist

- [x] Sync with `3mdistal/ralph#608` changes (rebase/adjust call sites as needed).

- [x] Add an explicit blocked classification for unresolvable profiles.
  - [x] Extend `src/blocked-sources.ts` with `profile-unresolvable` (or chosen equivalent string).
  - [x] Ensure any worker-failure/blocked reporting paths surface `blocked:profile-unresolvable`.

- [x] Fail closed in profile resolution core.
  - [x] Update `src/worker/opencode-profiles.ts` so that when profiles are enabled:
    - [x] start: if requested/auto/default profile cannot resolve to a configured profile, return a deterministic error (no ambient).
    - [x] resume: if the session id is missing or cannot be found under any configured profile storage, return a deterministic error (no ambient).
    - [x] keep `xdgConfigHome` intentionally *not* applied to worker runs.
  - [x] Replace string-only errors with typed error codes (e.g. `errorCode: "profile-unresolvable"` + `reasonCode` enum) so `RepoWorker` can deterministically map to `blocked-source=profile-unresolvable`.
  - [x] Enforce invariant: when `opencode.enabled=true`, start selection must never yield an "ambient"/null profile; if it does, return the typed unresolvable error immediately.
  - [x] (Maintainability) Split pure decision logic from filesystem scanning (session lookup) to keep a functional-core/imperative-shell boundary and reduce fs mocking in tests.

- [x] Handle unresolvable profile errors at worker entry points.
  - [x] In `src/worker/repo-worker.ts`, for both start and resume paths:
    - [x] Add explicit pre-session guard branches: if profile resolution returns a typed unresolvable error, mark the task `blocked` with `blocked-source=profile-unresolvable` and an actionable `blocked-reason`.
    - [x] Structurally guarantee no OpenCode spawn/continue occurs when blocked (avoid relying on generic catch classification).

- [x] Enforce shared managed config semantics across profile switches.
  - [x] Verify `src/session.ts` always uses the single Ralph-managed `OPENCODE_CONFIG_DIR` regardless of selected profile.
  - [x] Add/adjust tests to assert only usage/account routing inputs (XDG data/state/cache) vary across profiles.

- [x] Regression tests.
  - [x] Update `src/__tests__/worker-resume-opencode-profile-detection.test.ts` to expect fail-closed behavior when the session cannot be found.
  - [x] Add a test covering start failure when `opencode.enabled=true` but the default/requested profile is unresolvable.
  - [x] Add a test covering mixed-profile sequential runs (different profile XDG, same managed `OPENCODE_CONFIG_DIR`).
  - [x] Add a worker-level test asserting that on unresolvable profiles, the task is marked blocked with `blocked-source=profile-unresolvable` and that `runAgent`/`continueSession` are never invoked.

- [x] Run deterministic gates locally (as applicable): `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.
