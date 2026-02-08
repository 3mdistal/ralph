# Plan: Remove bwrb integration + remaining codepaths (#327)

## Goal

- Ralph runs with GitHub + SQLite only; no bwrb/vault integration is required.
- Repo contains no references to bwrb integration in code/docs (aside from historical notes in closed issues).

## Product Guidance (canonical)

- GitHub issues/labels/comments are the operator UX and queue truth; SQLite is durable internal state (`docs/product/orchestration-contract.md`).
- Escalations resume via `ralph:cmd:queue` (no implicit local auto-resume lane).
- Escalation “consultant decision packet” must still be attached deterministically (prefer GitHub writeback, not filesystem notes).

## Assumptions

- Dependency #326 is closed; proceed with deletion.
- Any remaining vault-backed escalation-note plumbing is effectively disabled today (e.g. `getVaultPath() -> null`), so deleting it is a net simplification.
- Maintain CLI/status output stability where reasonable (contract-surface): keep the notion of “pending escalations”, but derive it from GitHub task state (e.g. tasks with status `escalated`).

## Checklist

- [x] Inventory remaining bwrb-era references (expected: vault/escalation-note codepaths + tests) and define the deletion set.
- [x] Migrate “pending escalations” to GitHub task state:
- [x] Add a tiny shared helper used by all status surfaces to derive pending escalation count (from `getTasksByStatus("escalated")`).
- [x] Update `src/commands/status.ts` to use the helper (both JSON + text paths); remove `getEscalationsByStatus` usage.
- [x] Add/adjust tests for status output to lock this behavior (cover JSON + text).
- [x] Remove daemon wiring first (reduce runtime behavior surface):
- [x] Remove resolved-escalation auto-resume loop wiring from `src/index.ts`.
- [x] Remove vault-backed escalation consultant scheduler wiring from `src/index.ts` (GitHub writeback remains the sole packet attach path).
- [x] Delete bwrb/vault-era escalation modules:
- [x] Delete `src/escalation-notes.ts`, `src/escalation-resume.ts`, and `src/escalation-resume-scheduler.ts`.
- [x] Delete `src/escalation-consultant/scheduler.ts`.
- [x] Clean up escalation consultant I/O:
- [x] If `appendConsultantPacket()` becomes unused, remove the file-mutation path and keep only `generateConsultantPacket()` for GitHub writeback.
- [x] Update/remove tests accordingly to keep `knip` clean.
- [x] Update tests to match the new surfaces:
- [x] Remove tests for escalation note resolution parsing / auto-resume policy / resume scheduler.
- [x] Update scheduler tests to remove `getVaultPathForLogs` usage and any “vault” wording.
- [x] Keep/extend tests that ensure GitHub escalation comment writeback includes the consultant packet.
- [x] Terminology + docs sweep (contract-surface):
- [x] Update label descriptions (`src/github-labels.ts`) and docs to replace “see escalation note” with “see escalation comment/thread”.
- [x] Update `docs/escalation-policy.md` wording to avoid implying filesystem notes; keep policy centralized.
- [x] Docs/help text sweep: remove “vault”/bwrb-era wording (including comments) and ensure operator guidance remains GitHub+SQLite-first.
- [x] Final verification searches: zero matches for `bwrb`, `bitwarden`, `vault`, `escalation note`, `auto-resume`, and `getEscalationsByStatus`.
- [x] Run repo gates: `bun run typecheck`, `bun run build`, `bun run knip`, and `bun test` (fails in current workspace due pre-existing dist fixture/auth test environment issues).
