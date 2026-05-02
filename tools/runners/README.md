# Self-hosted Runner Provisioning

This directory documents the self-hosted GitHub Actions runners required by the
v0.3 daemon-split CI matrix. The runners themselves are operator-provisioned
out-of-band (per spec ch10 §6 "Self-hosted Win 11 25H2 runner provisioning") and
live in the separate `infra/win11-runner/` repository — this README is the
in-repo contract that workflow authors target by label.

> Source of truth: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`
> chapter 10 (Build, Package, Installer) §6 and chapter 11 (Monorepo Layout) §6.

## Runner labels

Two self-hosted runner labels are referenced by v0.3 CI workflows. Workflow
authors MUST use these exact labels via `runs-on: [self-hosted, <label>]`. Do
NOT invent new labels — talk to the operator first.

| Label             | OS / arch        | Purpose                                                               | Consumer task     |
| ----------------- | ---------------- | --------------------------------------------------------------------- | ----------------- |
| `ccsm-soak`       | linux x64        | Dedicated 1 hour pty soak run; sole-occupancy to avoid timing flakes  | T8.4 (#92)        |
| `win11-25h2-vm`   | Windows 11 25H2  | Installer / MSI roundtrip on a real 25H2 VM (snapshot-restored clean) | T7.4, T9.13       |

Notes:

- GitHub-hosted `windows-latest` is currently Server 2022, NOT Win 11 25H2 — the
  `win11-25h2-vm` label is a hard prerequisite for ship-gate (d), not optional.
- The `ccsm-soak` runner needs sole occupancy during the 1 hour window; do NOT
  share it with other long-running jobs.
- Both labels are referenced in the spec ch11 §6 sketch and consumed by the
  workflows shipped in T8.4 (#92) and T7.4 / T9.13.

## Provisioning checklist

This is a manual ops task performed in the `infra/win11-runner/` repo. It is
documented here so workflow authors know what each runner provides.

### Common (both runners)

- [ ] Register runner with the GitHub Actions repo under the appropriate label
      (`ccsm-soak` or `win11-25h2-vm`).
- [ ] Install Node 22.x (use volta or nvm — pin via `package.json` engines).
- [ ] Install pnpm 9.x (`npm i -g pnpm@9` or via corepack).
- [ ] Configure runner service to auto-restart on host reboot.
- [ ] Apply the runner label exactly as documented above (case-sensitive).
- [ ] Verify `gh-actions-runner` user has no shell login on production hosts.

### `ccsm-soak` (linux x64)

- [ ] Ubuntu 22.04 LTS minimum (matches spec ch11 §6 matrix `ubuntu-22.04`).
- [ ] Install `build-essential`, `python3`, `pkg-config`, `libsecret-1-dev`
      (required by `node-pty` + native module rebuilds).
- [ ] Reserve sole occupancy for the 1 hour soak window — no concurrent jobs.
- [ ] Disable unattended upgrades during soak windows (avoids mid-run reboots).

### `win11-25h2-vm` (Windows 11 25H2)

- [ ] Win 11 25H2 base image (build matches spec ch10 §6 / ch12 §3).
- [ ] WiX Toolset v3 (or v4) installed for MSI builds.
- [ ] PowerShell 7+ available as `pwsh`.
- [ ] VM snapshot named `win11-25h2-clean` (referenced by
      `Invoke-Snapshot-Restore` in `tools/installer-roundtrip.ps1`, see spec
      ch12 §3).
- [ ] Snapshot is restored to clean state before each run.

## Workflow usage

Target the labels via the `[self-hosted, <label>]` array form (spec ch11 §6):

```yaml
jobs:
  e2e-soak-1h:
    runs-on: [self-hosted, ccsm-soak]   # 1 hour pty soak — T8.4 (#92)
    steps:
      - run: pnpm run test:pty-soak

  e2e-installer-win:
    runs-on: [self-hosted, win11-25h2-vm]   # ship-gate (d) — T7.4 / T9.13
    steps:
      - run: pwsh tools/installer-roundtrip.ps1
```

A commented-out reference template lives at
`.github/workflows/_runners-template.yml`. The template is intentionally inert
(no triggers other than `workflow_dispatch` and every job gated by `if: false`)
so CI does not attempt to dispatch jobs against runners that may not yet be
registered.

## Scope of this PR (T0.10)

This PR is documentation-only. It establishes the in-repo contract for the two
self-hosted runner labels so downstream tasks (T8.4, T7.4, T9.13) can land
their workflows against a stable label name.

Explicitly out of scope:

- Activating the soak workflow — T8.4 (#92) ships the actual workflow.
- Activating the installer roundtrip workflow — T7.4 / T9.13 ship those.
- Registering runners — manual ops in `infra/win11-runner/`.
- Building VM base images — owned by the operator / `infra/win11-runner/` repo.
