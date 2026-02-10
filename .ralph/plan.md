# Plan: #669 Harden ralphctl daemon discovery vs legacy roots

Issue: https://github.com/3mdistal/ralph/issues/669

Assumptions (non-interactive defaults):
- Identity de-duplication key for daemon records is `(daemonId, pid)`; treat same key across multiple roots as the same live daemon.
- Fail closed only when there are multiple distinct *live* identities (multiple `(daemonId, pid)` pairs with alive PIDs).
- Preserve existing CLI exit code conventions; prefer additive JSON/report fields and new finding/repair codes.

## Checklist

- [x] Read issue + relevant product/docs guidance
- [x] Consult @product for success criteria
- [x] Consult @devex for maintainability + risk review
- [x] Create shared identity analysis core (pure): `src/daemon-identity-core.ts`
- [x] Add unit tests for identity core (table-driven): duplicates vs conflicts, representative selection tie-breaks
- [x] Update `src/daemon-discovery.ts` to use identity core:
- [x] Treat same-daemon duplicates across roots as `state="live"` (not conflict)
- [x] Fail closed only when multiple distinct live identities are present
- [x] Keep stale detection/heal behavior intact
- [x] Update/extend daemon discovery tests:
- [x] Same-daemon duplicate records across roots => live, canonical chosen as representative
- [x] Different-daemon live records (distinct identity keys) => conflict
- [x] Harden doctor reporting in `src/doctor/core.ts` using identity core:
- [x] Error only on multiple distinct live identities
- [x] Warn on duplicate live records for the same identity (add new finding code; additive-only)
- [x] Add repair recommendation(s) for safe de-duplication and legacy control cleanup (additive-only)
- [x] Implement doctor repair actions in `src/doctor/repair.ts`:
- [x] Quarantine duplicate daemon record files when safe (prefer keeping canonical; revalidate preconditions at execution time)
- [x] Provide safe cleanup path for legacy control files only when canonical exists + contents match + no live record references the legacy path
- [x] Update/extend doctor repair tests + CLI doctor tests for new behavior
- [x] Run targeted tests: `bun test src/__tests__/daemon-discovery.test.ts src/__tests__/doctor-repair.test.ts src/__tests__/ralphctl-doctor-cli.test.ts`
- [x] Run full suite (`bun test`) and `bun run typecheck` (full suite currently has unrelated pre-existing hook timeouts in other test files)
