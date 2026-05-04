# tools/update-flow/lib/stop-with-escalation.ps1
#
# Stop the ccsm-daemon Windows service with the spec-locked escalation:
#   1. Stop-Service ccsm-daemon — wait up to 10s for clean exit.
#   2. If still running, Stop-Service -Force; wait 5s.
#   3. If still running, taskkill /F /PID <pid>.
#   4. Verify PID is gone via Get-Process before returning success.
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8 step 1.
#
# Contract:
#   - exit 0 = service stopped (verified via Get-Process)
#   - exit non-zero = could not stop within total budget
#
# v0.3 SKETCH per ch10 §8 (manual pre-release smoke; CI in v0.4).

[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'ccsm-daemon'

function Write-Log($msg) { Write-Host "[stop-with-escalation] $msg" }

function Invoke-DryOrReal {
  param([scriptblock]$Block, [string]$Description)
  if ($DryRun) {
    Write-Log "DRY-RUN: would: $Description"
    return
  }
  & $Block
}

function Test-PidGone {
  if ($DryRun) { return $true }
  $p = Get-Process -Name $ServiceName -ErrorAction SilentlyContinue
  return ($null -eq $p)
}

function Stop-Polite {
  Invoke-DryOrReal -Description "Stop-Service $ServiceName" -Block {
    try { Stop-Service -Name $ServiceName -ErrorAction Stop } catch {
      Write-Log "Stop-Service failed (may already be stopped): $_"
    }
  }
}

function Stop-Force {
  Invoke-DryOrReal -Description "Stop-Service -Force $ServiceName" -Block {
    try { Stop-Service -Name $ServiceName -Force -ErrorAction Stop } catch {
      Write-Log "Stop-Service -Force failed: $_"
    }
  }
}

function Stop-Taskkill {
  Invoke-DryOrReal -Description "taskkill /F /IM ${ServiceName}.exe" -Block {
    & taskkill.exe /F /IM "${ServiceName}.exe" 2>&1 | Out-Null
  }
}

# --- main ---
Write-Log "polite stop"
Stop-Polite

for ($i = 0; $i -lt 10; $i++) {
  if (Test-PidGone) {
    Write-Log "service stopped politely"
    exit 0
  }
  if ($DryRun) { break }
  Start-Sleep -Seconds 1
}

Write-Log "polite stop timed out, escalating to Stop-Service -Force"
Stop-Force

for ($i = 0; $i -lt 5; $i++) {
  if (Test-PidGone) {
    Write-Log "service force-stopped"
    exit 0
  }
  if ($DryRun) { break }
  Start-Sleep -Seconds 1
}

Write-Log "force stop failed, escalating to taskkill /F"
Stop-Taskkill

if (Test-PidGone) {
  Write-Log "service killed"
  exit 0
}

Write-Log "ERROR: service still running after taskkill"
exit 1
