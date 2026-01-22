# CI Checks (Canonical Reference)

This doc summarizes the CI checks that run for this repo. It is a reference
derived from the workflow and scripts below, not the authoritative source for
required checks.

## Authoritative Sources

- `.github/workflows/ci.yml` (workflow steps and ordering)
- `package.json` (script definitions)
- `README.md` (required check configuration via `repos[].requiredChecks`)

## Repo Language

The codebase is TypeScript. Compilation and typechecking use `tsc`.

## CI Checks

CI runs under the GitHub workflow named `CI` and performs these steps:

- `bun test` (test suite)
- `bun run typecheck` (TypeScript typecheck)
- `bun run build` (TypeScript build + managed template copy)
- `bun run knip` (unused code/dependency analysis)
