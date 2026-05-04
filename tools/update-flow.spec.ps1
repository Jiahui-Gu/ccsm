# tools/update-flow.spec.ps1
#
# In-place update + rollback flow for ccsm-daemon (Windows).
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8.
#
# Steps (per spec):
#   1. Stop service with 10s + SIGKILL escalation (lib/stop-with-escalation.ps1).
#   2. Rename existing binary -> ccsm-daemon.prev.exe (lib/rename-prev.ps1).
#   3. Move staged binary into place; Start-Service.
#   4. Poll /healthz for 10s. If 200: delete .prev. If timeout: rollback
#      (lib/rollback.ps1) — restore .prev, restart, log crash_log entry
#      with source=update_rollback (regardless of whether the rollback
#      healthz succeeds, so the user sees the failure surfaced via ch09).
#
# v0.3 SCOPE: this is a SKETCH per ch10 §8 ("manual pre-release smoke v0.3,
# CI in v0.4"). The script is dry-run-capable end-to-end so the v0.3
# release rehearsal can validate it without touching a live system.
#
# Usage:
#   pwsh -File tools/update-flow.spec.ps1 -DryRun
#   pwsh -File tools/update-flow.spec.ps1 -Staged C:\tmp\new-ccsm-daemon.exe `
#                                          -InstallRoot 'C:\Program Files\ccsm' `
#                                          -StateDir 'C:\ProgramData\ccsm' `
#                                          -HealthzUrl 'http://localhost:9876/healthz'
#
# Exit 0 = update succeeded OR rollback succeeded.
# Exit non-zero = catastrophic failure (rollback also failed).

[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$Staged,
  [string]$InstallRoot = 'C:\Program Files\ccsm',
  [string]$StateDir,
  [string]$HealthzUrl = 'http://localhost:9876/healthz',
  [int]$HealthzTimeoutSec = 10,
  # Allows tests / dry-run rehearsal to force the healthz outcome without
  # spinning a real service. One of: '', 'pass', 'fail'.
  [string]$SimulateHealthz = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($StateDir)) {
  $programData = $env:ProgramData
  if ([string]::IsNullOrWhiteSpace($programData)) { $programData = 'C:\ProgramData' }
  $StateDir = Join-Path $programData 'ccsm'
}

$ScriptDir = Split-Path -Parent $PSCommandPath
$LibDir = Join-Path $ScriptDir 'update-flow\lib'

function Write-Log($msg) { Write-Host "[update-flow] $msg" }

function Invoke-Lib {
  param([string]$Script, [string[]]$LibArgs)
  $path = Join-Path $LibDir $Script
  # Run inline and force child stdout straight to the host instead of into
  # the pipeline (otherwise the function's implicit return-value capture
  # would swallow it and turn the line-array into the "exit code"). Use
  # Out-Default so callers see the child output in real time.
  & pwsh -NoProfile -File $path @LibArgs | Out-Default
  return $LASTEXITCODE
}

$dryArgs = @()
if ($DryRun) { $dryArgs += '-DryRun' }

# --- step 1: stop ---
function Step-Stop {
  Write-Log 'step 1/4 — stop service'
  $code = Invoke-Lib 'stop-with-escalation.ps1' $dryArgs
  if ($code -ne 0) { throw "stop-with-escalation exit=$code" }
}

# --- step 2: rename existing -> .prev ---
function Step-Rename {
  Write-Log 'step 2/4 - rename existing binary -> .prev'
  $libArgs = $dryArgs + @('-InstallRoot', $InstallRoot)
  $code = Invoke-Lib 'rename-prev.ps1' $libArgs
  if ($code -ne 0) { throw "rename-prev exit=$code" }
}

# --- step 3: stage + restart ---
function Step-StageAndRestart {
  Write-Log 'step 3/4 — move staged binary into place + Start-Service'
  if ($DryRun) {
    $stagedDisplay = if ($Staged) { $Staged } else { 'C:\tmp\staged-ccsm-daemon.exe' }
    Write-Log "DRY-RUN: would move $stagedDisplay -> $InstallRoot\ccsm-daemon.exe"
    Write-Log 'DRY-RUN: would Start-Service ccsm-daemon'
    return
  }
  if ([string]::IsNullOrWhiteSpace($Staged) -or -not (Test-Path -LiteralPath $Staged)) {
    throw "staged binary missing or unset: $Staged"
  }
  $dest = Join-Path $InstallRoot 'ccsm-daemon.exe'
  Move-Item -LiteralPath $Staged -Destination $dest -Force
  Start-Service -Name 'ccsm-daemon'
}

# --- step 4: healthz + rollback ---
function Test-Healthz {
  if ($SimulateHealthz -eq 'pass') { return $true }
  if ($SimulateHealthz -eq 'fail') { return $false }
  if ($DryRun) {
    Write-Log "DRY-RUN: would poll $HealthzUrl for ${HealthzTimeoutSec}s"
    return $true
  }
  for ($i = 0; $i -lt $HealthzTimeoutSec; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $HealthzUrl -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
      if ($r.StatusCode -eq 200) { return $true }
    } catch {
      # swallow — retry
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Step-HealthzOrRollback {
  Write-Log "step 4/4 — poll /healthz (${HealthzTimeoutSec}s budget)"
  if (Test-Healthz) {
    Write-Log 'healthz OK — update succeeded; deleting .prev'
    if ($DryRun) {
      Write-Log "DRY-RUN: would remove $InstallRoot\ccsm-daemon.prev.exe and native.prev"
    } else {
      $binPrev = Join-Path $InstallRoot 'ccsm-daemon.prev.exe'
      $nativePrev = Join-Path $InstallRoot 'native.prev'
      if (Test-Path -LiteralPath $binPrev) { Remove-Item -LiteralPath $binPrev -Force }
      if (Test-Path -LiteralPath $nativePrev) { Remove-Item -LiteralPath $nativePrev -Recurse -Force }
    }
    return 0
  }

  Write-Log 'healthz FAILED — initiating rollback'
  Invoke-Lib 'stop-with-escalation.ps1' $dryArgs | Out-Null
  $rbArgs = $dryArgs + @(
    '-InstallRoot', $InstallRoot,
    '-StateDir', $StateDir,
    '-Reason', "post-update healthz failed within ${HealthzTimeoutSec}s"
  )
  $rbExit = Invoke-Lib 'rollback.ps1' $rbArgs

  if (-not $DryRun) {
    try { Start-Service -Name 'ccsm-daemon' } catch { Write-Log "post-rollback Start-Service failed: $_" }
  }
  return $rbExit
}

# --- main ---
Write-Log "ccsm-daemon update flow start (DryRun=$DryRun)"
Write-Log "  install-root: $InstallRoot"
Write-Log "  state-dir:    $StateDir"
Write-Log "  healthz:      $HealthzUrl"

Step-Stop
Step-Rename
Step-StageAndRestart
$exit = Step-HealthzOrRollback
Write-Log 'update flow complete'
exit $exit
