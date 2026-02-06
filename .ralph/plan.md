# Plan: Update canonical.jsonl statuses for #494 claims (#578)

## Goal

- Reconcile `claims/canonical.jsonl` with shipped code so #494-related orchestration claims are trustworthy for drift checks and planning.

## Checklist

- [x] Enumerate candidate #494-related claims by `id`:
  - Start with the 5 suggested in the issue.
  - Also scan `claims/canonical.jsonl` for other `domain=orchestration` claims under `labels/ralph:cmd:*`, `labels/ralph:status:*`, and `labels/bootstrap*` that are still `planned`.
- [x] For each candidate claim, define the invariant precisely and set a flip-to-implemented bar:
  - Must have a shipped enforcement point (not just a doc).
  - Must have at least one automated check covering the invariant (existing test, or a small new one if cheap/high-signal).
- [x] Gather positive evidence per claim:
  - Identify the single best owner module that enforces the invariant (prefer stable boundary modules; avoid huge call sites like `src/index.ts` / `src/worker/repo-worker.ts`).
- [x] Gather negative evidence per claim:
  - Look for bypasses/counterexamples in shipped paths (e.g. non-`ralph:*` label mutations, label ops that explicitly allow non-`ralph:*` labels, or degraded-mode write failures that never converge).
  - If counterexamples exist, keep `planned` and record "what's missing" for the PR description.
- [x] Update `claims/canonical.jsonl`:
  - Flip `planned` -> `implemented` only when the bar is met.
  - Set `source` to the stable enforcement boundary module (add extra context in the PR body rather than encoding brittle pointers into `source`).
- [x] Add/ensure a structural validation check for `claims/canonical.jsonl`:
  - Parse every JSONL line.
  - Enforce required keys and unique `id`.
- [x] Run verification:
  - Always: `bun test`
  - Usually: `bun run typecheck`
  - If feasible for CI parity: `bun run build` and `bun run knip`
- [ ] Open PR targeting `bot/integration` with a description that lists:
  - claims flipped to implemented (id + brief evidence)
  - claims left planned (id + concrete "what's missing")
