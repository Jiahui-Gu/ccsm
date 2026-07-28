# Windows-Only CI Design

## Decision

CCSM is a Windows-only product and development target. CI, E2E validation, and
future compatibility work target Windows. The project will not invest in
macOS/Linux compatibility or test coverage unless this policy is explicitly
revisited.

## Scope

- Collapse `.github/workflows/ci.yml` to one `windows-latest` job named
  `lint + typecheck + test (windows-latest)`.
- Run lint, typecheck, build, unit/integration tests, Cloudflare tests,
  Cloudflare dry-run, coverage, and coverage artifact upload in that job.
- Collapse `.github/workflows/e2e.yml` to one `windows-latest` job named
  `e2e (windows-latest)`.
- Run the existing Windows E2E suite in that job without matrix, xvfb, or
  platform branches.
- Add the Windows-only constraint to `AGENTS.md` and `CLAUDE.md`.
- Update branch protection to require:
  - `lint + typecheck + test (windows-latest)`
  - `e2e (windows-latest)`
  - `no-silent-drops`

## Non-Goals

- No changes to README, release workflows, package scripts, packaging targets,
  or existing cross-platform release documentation.
- No product-code, test-code, Cloudflare, or dependency changes.
- No macOS/Linux fallback jobs or compatibility exceptions.
- No release, deployment, or branch-protection changes before the workflow
  updates have produced the replacement Windows contexts.

## Workflow Changes

### CI

Remove the OS matrix, matrix expressions, Linux/macOS setup, platform-specific
conditions, and comments that describe cross-platform behavior. Keep the
current validation steps and caches, adapted to one `windows-latest` runner.
Cloudflare validation and coverage become unconditional steps in the Windows
job. The externally visible job name remains exactly
`lint + typecheck + test (windows-latest)`.

### E2E

Remove the OS matrix, xvfb execution, Linux/macOS branches, and comments that
describe cross-platform behavior. Keep the existing dependency setup, Electron
and Playwright preparation, build, Claude CLI setup, E2E execution, and failure
artifact upload on one `windows-latest` runner. The externally visible job name
remains exactly `e2e (windows-latest)`.

### Agent Guidance

Add a prominent hard constraint to both agent instruction files: CCSM targets
Windows only, validation runs on Windows, and new work must not spend effort on
macOS/Linux compatibility or testing.

## Validation

1. Validate both workflow files as YAML and inspect their rendered job names.
2. Confirm each workflow has one `windows-latest` job and no matrix, xvfb, or
   Linux/macOS conditional remains.
3. Confirm CI runs lint, typecheck, build, tests, Cloudflare test/dry-run, and
   coverage; confirm E2E runs the existing Windows probe suite.
4. Open a pull request and wait for both replacement Windows contexts and
   `no-silent-drops` to pass.

## Branch Protection Order

1. Open a pull request with the workflow and agent-guidance changes while
   current branch protection remains unchanged.
2. Let that pull request run the updated workflows and verify the two exact
   Windows context names appear and pass. The pull request may remain blocked
   by the old required matrix contexts during this transition.
3. Replace the old matrix contexts in branch protection with the two verified
   Windows contexts, retaining `no-silent-drops`.
4. Confirm the pull request is gated by exactly those three checks, then merge
   it through the normal review process.

This order prevents a required-check gap and avoids deadlocking pull requests on
contexts that have not yet been emitted.
