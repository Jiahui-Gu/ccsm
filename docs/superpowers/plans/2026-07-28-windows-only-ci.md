# Windows-Only CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows the sole CCSM product-development and validation target while preserving the existing Windows check names and safely migrating branch protection.

**Architecture:** Project policy lives in `AGENTS.md` and `CLAUDE.md`; GitHub Actions emits one static Windows CI context and one static Windows E2E context. Delivery pushes those workflows first, waits for both replacement contexts to pass on PR #1483, then atomically replaces the required context list while preserving strict branch synchronization.

**Tech Stack:** GitHub Actions YAML, `windows-latest`, Node.js 22, npm, PowerShell 7, GitHub CLI (`gh`)

## Global Constraints

- CCSM is a Windows-only product and development target.
- CI, E2E validation, and future compatibility work target Windows.
- Do not invest in macOS/Linux compatibility or test coverage unless this policy is explicitly revisited.
- Keep the required check names exactly `lint + typecheck + test (windows-latest)`, `e2e (windows-latest)`, and `no-silent-drops`.
- Use npm only and Node.js 22 or newer.
- Leave `README.md`, `.github/workflows/release.yml`, `.github/workflows/hourly-tag-release.yml`, `package.json`, packaging targets, and existing cross-platform release documentation unchanged.
- Do not modify product code, test code, Cloudflare code, dependencies, or deployment configuration.
- Push the replacement workflows and observe both Windows contexts before changing branch protection.
- Do not deploy, merge PR #1483, close or modify PR #1481, create a release, or create a tag.
- Every implementation commit must include `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`.

## File Map

- Modify `AGENTS.md`: declare the Windows-only product and development policy in the broad agent guidance.
- Modify `CLAUDE.md`: repeat the same Windows-only rule in the condensed non-negotiable checklist.
- Modify `.github/workflows/ci.yml`: replace the three-OS matrix with one static Windows validation job.
- Modify `.github/workflows/e2e.yml`: replace the three-OS matrix and platform branches with one static Windows E2E job.
- No files are created, deleted, renamed, or modified outside those four paths.

---

### Task 1: Record the Windows-Only Development Policy

**Files:**
- Modify: `AGENTS.md:12-14`
- Modify: `CLAUDE.md:8-10`

**Interfaces:**
- Consumes: the approved decision in `docs/superpowers/specs/2026-07-27-windows-only-ci-design.md`
- Produces: identical Windows-only constraints for full and condensed agent instructions

- [ ] **Step 1: Confirm the insertion points and out-of-scope files are unchanged**

Run:

```powershell
git status --short
git diff --exit-code cbc102c23ce33eab33d3ca307f34669e2483a08f..HEAD -- README.md .github/workflows/release.yml .github/workflows/hourly-tag-release.yml package.json
```

Expected: both commands print no output and exit with code 0.

- [ ] **Step 2: Add the policy to `AGENTS.md`**

Insert this bullet immediately after `## Hard constraints (read first)` and before the npm rule:

```markdown
- **Windows only.** CCSM is a Windows-only product and development target.
  CI, E2E validation, and future compatibility work target Windows. Do not
  invest in macOS/Linux compatibility or testing unless this policy is
  explicitly revisited.
```

- [ ] **Step 3: Add the policy to `CLAUDE.md`**

Insert this bullet immediately after `## Non-negotiable rules` and before the npm rule:

```markdown
- **Windows only.** CCSM is a Windows-only product and development target.
  Run product validation on Windows, and do not invest in macOS/Linux
  compatibility or testing unless this policy is explicitly revisited.
```

- [ ] **Step 4: Verify both instruction files express the same policy**

Run:

```powershell
rg -n -A 3 "Windows only" AGENTS.md CLAUDE.md
git diff --check
git diff -- AGENTS.md CLAUDE.md
```

Expected: `rg` prints one four-line policy block from each file; `git diff --check` prints no output; the diff contains only the two bullets above.

- [ ] **Step 5: Commit the policy**

Run:

```powershell
git add -- AGENTS.md CLAUDE.md
git commit -m "docs: define Windows-only development target" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

Expected: one commit reports `2 files changed` and the working tree is clean.

---

### Task 2: Collapse CI to One Windows Job

**Files:**
- Modify: `.github/workflows/ci.yml:1-110`

**Interfaces:**
- Consumes: existing npm scripts `lint`, `typecheck`, `build`, `test`, `test:cloudflare`, `cloudflare:dry-run`, and `coverage`
- Produces: required context `lint + typecheck + test (windows-latest)`

- [ ] **Step 1: Replace `.github/workflows/ci.yml` with the static Windows workflow**

Use this complete file content:

```yaml
name: CI

on:
  # No paths-ignore: branch protection requires this workflow's Windows
  # context. Skipping it would leave doc-only pull requests pending forever.
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  lint-typecheck-test:
    name: lint + typecheck + test (windows-latest)
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      # Restoring node_modules skips npm install and the native rebuild on a
      # warm cache. OS, architecture, Node major, and lockfile changes bust it.
      - name: Cache node_modules
        id: nm_cache
        uses: actions/cache@v4
        with:
          path: node_modules
          key: nm-${{ runner.os }}-${{ runner.arch }}-node22-${{ hashFiles('package-lock.json') }}

      - name: Install deps
        if: steps.nm_cache.outputs.cache-hit != 'true'
        run: npm ci --legacy-peer-deps
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck

      # The load-smoke tests require the compiled Electron output.
      - name: Build
        run: npm run build

      - name: Test
        run: npm test

      - name: Test Cloudflare relay
        run: npm run test:cloudflare

      - name: Dry-run Cloudflare bundle
        run: npm run cloudflare:dry-run

      - name: Coverage
        run: npm run coverage

      - name: Upload coverage artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-lcov
          path: coverage/lcov.info
          if-no-files-found: warn
```

- [ ] **Step 2: Parse the YAML and assert the static job contract**

Run:

```powershell
node -e "const fs=require('fs');const yaml=require('js-yaml');const p='.github/workflows/ci.yml';const d=yaml.load(fs.readFileSync(p,'utf8'));const j=d.jobs['lint-typecheck-test'];if(j.name!=='lint + typecheck + test (windows-latest)'||j['runs-on']!=='windows-latest'||j.strategy)throw new Error('CI job contract mismatch');const runs=j.steps.filter(s=>s.run).map(s=>s.run);for(const cmd of ['npm run lint','npm run typecheck','npm run build','npm test','npm run test:cloudflare','npm run cloudflare:dry-run','npm run coverage'])if(!runs.includes(cmd))throw new Error('missing '+cmd);console.log('ci.yml: one static Windows job with all required commands')"
```

Expected:

```text
ci.yml: one static Windows job with all required commands
```

- [ ] **Step 3: Prove matrix and platform-specific CI logic are gone**

Run:

```powershell
if (rg -n "matrix|ubuntu-latest|macos-latest|runner\.os|setup-python" .github/workflows/ci.yml) { throw "Cross-platform CI logic remains" }
rg -n "name: lint \+ typecheck \+ test \(windows-latest\)|runs-on: windows-latest|npm run test:cloudflare|npm run cloudflare:dry-run|npm run coverage|if: always\(\)" .github/workflows/ci.yml
git diff --check
```

Expected: the first command prints no matches; the second prints the exact Windows job name, runner, unconditional Cloudflare and coverage commands, and `if: always()` for artifact upload; `git diff --check` prints no output.

- [ ] **Step 4: Commit the CI workflow**

Run:

```powershell
git add -- .github/workflows/ci.yml
git commit -m "ci: run validation on Windows only" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

Expected: one commit reports only `.github/workflows/ci.yml` changed and the working tree is clean.

---

### Task 3: Collapse E2E to One Windows Job

**Files:**
- Modify: `.github/workflows/e2e.yml:1-155`

**Interfaces:**
- Consumes: existing `npm run probe:e2e` harness runner and `E2E_SKIP=harness-ime-overflow`
- Produces: required context `e2e (windows-latest)` and Windows failure artifact `e2e-logs-windows-latest`

- [ ] **Step 1: Replace `.github/workflows/e2e.yml` with the static Windows workflow**

Use this complete file content:

```yaml
name: e2e

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  e2e:
    name: e2e (windows-latest)
    runs-on: windows-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      # E2E keeps a distinct node_modules cache because it needs the Electron
      # binary and native modules rebuilt for Electron's ABI.
      - name: Cache node_modules
        id: nm_cache
        uses: actions/cache@v4
        with:
          path: node_modules
          key: nm-e2e-${{ runner.os }}-${{ runner.arch }}-node22-${{ hashFiles('package-lock.json') }}

      - name: Cache Electron binary
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/electron
            ~/.cache/electron-builder
          key: electron-${{ runner.os }}-${{ hashFiles('package-lock.json') }}

      - name: Install deps
        if: steps.nm_cache.outputs.cache-hit != 'true'
        run: npm ci --legacy-peer-deps

      - name: Ensure Electron binary
        run: node node_modules/electron/install.js

      - name: Ensure Playwright Chromium
        run: npx playwright install chromium

      - name: Ensure native modules built for Electron ABI
        run: npx electron-rebuild

      - name: Build
        run: npm run build

      # The curated real-CLI harness uses a localhost fake Anthropic API.
      - name: Install claude CLI globally
        run: npm i -g @anthropic-ai/claude-code

      - name: Verify claude binary
        run: claude --version

      - name: Pre-approve fake API key
        shell: bash
        run: |
          node -e "
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const cfgPath = path.join(os.homedir(), '.claude.json');
            let cfg = {};
            if (fs.existsSync(cfgPath)) {
              try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
            }
            cfg.customApiKeyResponses = cfg.customApiKeyResponses || {};
            cfg.customApiKeyResponses.approved = ['fake-ci-key'];
            cfg.hasCompletedOnboarding = true;
            cfg.bypassPermissionsModeAccepted = true;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
            console.log('seeded', cfgPath);
          "

      - name: Run e2e
        run: npm run probe:e2e
        env:
          E2E_SKIP: harness-ime-overflow

      - name: Upload e2e logs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-logs-windows-latest
          path: |
            docs/screenshots/
          retention-days: 7
```

- [ ] **Step 2: Parse the YAML and assert the static E2E contract**

Run:

```powershell
node -e "const fs=require('fs');const yaml=require('js-yaml');const p='.github/workflows/e2e.yml';const d=yaml.load(fs.readFileSync(p,'utf8'));const j=d.jobs.e2e;if(j.name!=='e2e (windows-latest)'||j['runs-on']!=='windows-latest'||j.strategy)throw new Error('E2E job contract mismatch');const run=j.steps.find(s=>s.name==='Run e2e');if(run.run!=='npm run probe:e2e'||run.env.E2E_SKIP!=='harness-ime-overflow')throw new Error('E2E command mismatch');const artifact=j.steps.find(s=>s.name==='Upload e2e logs on failure');if(artifact.with.name!=='e2e-logs-windows-latest')throw new Error('artifact name mismatch');console.log('e2e.yml: one static Windows job with the existing probe suite')"
```

Expected:

```text
e2e.yml: one static Windows job with the existing probe suite
```

- [ ] **Step 3: Prove matrix and platform branches are gone**

Run:

```powershell
if (rg -n "matrix|ubuntu-latest|macos-latest|xvfb|runner\.os|Run e2e \(Linux|Run e2e \(mac/win\)" .github/workflows/e2e.yml) { throw "Cross-platform E2E logic remains" }
rg -n "name: e2e \(windows-latest\)|runs-on: windows-latest|name: Run e2e|npm run probe:e2e|name: e2e-logs-windows-latest" .github/workflows/e2e.yml
git diff --check
```

Expected: the first command prints no matches; the second prints the exact Windows context, runner, probe command, and static artifact name; `git diff --check` prints no output.

- [ ] **Step 4: Commit the E2E workflow**

Run:

```powershell
git add -- .github/workflows/e2e.yml
git commit -m "ci: run E2E on Windows only" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

Expected: one commit reports only `.github/workflows/e2e.yml` changed and the working tree is clean.

---

### Task 4: Validate, Push, and Migrate Required Checks

**Files:**
- Verify unchanged: `README.md`
- Verify unchanged: `.github/workflows/release.yml`
- Verify unchanged: `.github/workflows/hourly-tag-release.yml`
- Verify unchanged: `package.json`
- GitHub setting: `repos/Jiahui-Gu/ccsm/branches/main/protection/required_status_checks`

**Interfaces:**
- Consumes: the two exact Windows contexts emitted by Tasks 2 and 3 on PR #1483
- Produces: branch protection requiring exactly those contexts plus `no-silent-drops`

- [ ] **Step 1: Verify scope and repository cleanliness**

Run:

```powershell
git diff --exit-code cbc102c23ce33eab33d3ca307f34669e2483a08f..HEAD -- README.md .github/workflows/release.yml .github/workflows/hourly-tag-release.yml package.json
git status --short
git log --oneline -3
```

Expected: the diff and status commands print no output. The log shows the
subjects `ci: run E2E on Windows only`, `ci: run validation on Windows only`,
and `docs: define Windows-only development target` in that newest-first order,
each prefixed by its generated abbreviated commit SHA.

- [ ] **Step 2: Run static validation**

Run:

```powershell
npm run typecheck
npm run lint
```

Expected: both commands exit with code 0; typecheck prints no TypeScript diagnostics, and lint prints no errors or warnings.

- [ ] **Step 3: Run unit, Cloudflare, and build validation**

Run:

```powershell
npm test
npm run test:cloudflare
npm run build
```

Expected:

```text
npm test: 230 test files passed, 2085 tests passed, and the existing single pending test remains
npm run test:cloudflare: 27 tests passed
npm run build: exit code 0 with Electron and renderer builds completed
```

- [ ] **Step 4: Run the Windows E2E suite with the workflow exclusion**

Run:

```powershell
$env:E2E_SKIP = 'harness-ime-overflow'
npm run probe:e2e
$e2eExit = $LASTEXITCODE
Remove-Item Env:E2E_SKIP
if ($e2eExit -ne 0) { exit $e2eExit }
```

Expected: the E2E summary reports zero failed harnesses, `harness-ime-overflow` as skipped, and the command exits with code 0. The temporary environment variable is removed.

- [ ] **Step 5: Push the replacement workflows before changing protection**

Run:

```powershell
git push origin jiahui-gu-simplify-desktop-mirror
```

Expected: `origin/jiahui-gu-simplify-desktop-mirror` advances to the Task 3 commit. This push triggers PR #1483 with the two replacement Windows contexts while the seven existing required contexts remain configured.

- [ ] **Step 6: Wait until both replacement Windows contexts appear and pass**

Run:

```powershell
$windowsChecks = @(
  'lint + typecheck + test (windows-latest)',
  'e2e (windows-latest)'
)
do {
  $checks = @(gh pr checks 1483 --json name,state | ConvertFrom-Json)
  $states = @{}
  foreach ($check in $checks) {
    if ($check.name -in $windowsChecks) {
      $states[$check.name] = $check.state
    }
  }
  $pending = @($windowsChecks | Where-Object { $states[$_] -ne 'SUCCESS' })
  if ($pending.Count -gt 0) {
    Start-Sleep -Seconds 15
  }
} until ($pending.Count -eq 0)
$windowsChecks | ForEach-Object { "$_ : $($states[$_])" }
```

Expected:

```text
lint + typecheck + test (windows-latest) : SUCCESS
e2e (windows-latest) : SUCCESS
```

Do not proceed if either exact context is absent, pending, cancelled, skipped, or failed.

- [ ] **Step 7: Replace only the required context list**

Run this PowerShell JSON pipeline. It reads and preserves the current `strict` value, which is expected to be `true`.

```powershell
$endpoint = 'repos/Jiahui-Gu/ccsm/branches/main/protection/required_status_checks'
$current = gh api $endpoint | ConvertFrom-Json
$payload = [ordered]@{
  strict = [bool]$current.strict
  contexts = @(
    'lint + typecheck + test (windows-latest)'
    'e2e (windows-latest)'
    'no-silent-drops'
  )
}
$payload | ConvertTo-Json -Depth 3 -Compress |
  gh api --method PATCH $endpoint --input -
```

Expected: the API response has `"strict": true` and contains exactly the three requested contexts. No other branch-protection endpoint is modified.

- [ ] **Step 8: Wait for the required PR checks**

Run:

```powershell
gh pr checks 1483 --required --watch --fail-fast
```

Expected: exit code 0 with these three required checks successful:

```text
lint + typecheck + test (windows-latest)
e2e (windows-latest)
no-silent-drops
```

- [ ] **Step 9: Verify branch protection exactly**

Run:

```powershell
$endpoint = 'repos/Jiahui-Gu/ccsm/branches/main/protection/required_status_checks'
$required = gh api $endpoint | ConvertFrom-Json
$expected = @(
  'e2e (windows-latest)'
  'lint + typecheck + test (windows-latest)'
  'no-silent-drops'
)
$actual = @($required.contexts | Sort-Object)
if (-not $required.strict) { throw 'strict required status checks must remain enabled' }
if (Compare-Object $expected $actual) { throw 'required context list mismatch' }
"strict: $($required.strict)"
$actual
```

Expected:

```text
strict: True
e2e (windows-latest)
lint + typecheck + test (windows-latest)
no-silent-drops
```

- [ ] **Step 10: Confirm the branch remains clean and stop**

Run:

```powershell
git status --short
git rev-parse HEAD
```

Expected: status prints no output; HEAD is the Task 3 commit already pushed to `origin/jiahui-gu-simplify-desktop-mirror`. Do not merge or deploy.
