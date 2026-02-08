# Plan: Trace bundle exporter for sandbox runs (#254)

Assumption (based on prefetched dossier + GitHub state): sub-issues #561-#565 are already implemented and closed; remaining work is admin closeout with deterministic evidence.

- Persist a run-scoped trace directory keyed by `runId` with worker/tool timeline and GitHub request ids.
- Add `sandbox:collect` to package logs + manifest + key links into one folder.
- Ensure exported artifacts are redacted.

## Assumptions

- Sandbox runs should always export a trace bundle at run completion.
- Production export is optional and can be enabled via `RALPH_TRACE_BUNDLE=1`.
- Existing run/session pointers in SQLite are the source of truth for artifact discovery.

## Checklist

- [x] Implement trace bundle collector module (timeline + GitHub requests + artifact copies)
- [x] Redact exported raw artifacts
- [x] Trigger bundle export automatically for sandbox runs
- [x] Add `ralph sandbox:collect` CLI command
- [x] Add focused unit test for bundle collection
- [x] Run verification (`bun test` targeted + `bun run typecheck`)
