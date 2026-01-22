# CI Checks (Derived Reference)

This doc summarizes the CI checks that run for this repo. It is a reference
derived from the workflow and scripts below, not the authoritative source for
required checks. If you change `.github/workflows/ci.yml` or the referenced
scripts, update this doc.

## Source References

- `.github/workflows/ci.yml` (workflow steps and ordering)
- `package.json` (script definitions)
- `README.md` (Ralph config surface for `repos[].requiredChecks`)
- GitHub branch protection / required checks (authoritative check contexts)

## Repo Language

The codebase is TypeScript. Compilation and typechecking use `tsc`.

## CI Checks

CI runs under the GitHub workflow named `CI`. The key check commands are
listed below. For the full workflow (including checkout and Bun setup), refer
to `.github/workflows/ci.yml`.

- Install: `bun install --frozen-lockfile`
- Test: `bun test` (test suite)
- Typecheck: `bun run typecheck` (TypeScript typecheck)
- Build: `bun run build` (TypeScript build + `scripts/copy-managed-templates.ts`)
- Knip: `bun run knip` (unused code/dependency analysis)

## Required Checks Note

When configuring `repos[].requiredChecks`, use the exact check context name
shown in GitHub branch protection for this workflow. GitHub required checks are
job/check-run contexts (not individual steps), and the UI often shows them in a
`<workflow> / <job>` format (typically `CI / ci` for this workflow).
