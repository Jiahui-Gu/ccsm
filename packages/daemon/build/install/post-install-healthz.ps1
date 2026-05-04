# packages/daemon/build/install/post-install-healthz.ps1
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5 step 7 (post-install /healthz wait + 10s failure rollback).
# Task: T7.5 (#78) — installer: post-install /healthz wait + 10s failure rollback.
#
# Used by: WiX 4 CustomAction CcsmHealthzCheck (see win/HealthzCustomAction.wxs.template),
# wired in win/Product.wxs.template after ServiceControl Start="install".
#
# Responsibilities (ch10 §5 step 7 — Windows branch):
#   - After ServiceControl starts ccsm-daemon, poll Supervisor /healthz
#     over the named pipe \\.\pipe\ccsm-supervisor for HTTP 200, wait up
#     to 10s.
#   - On timeout / non-200: capture last 200 events from Application
#     event log filtered to ccsm provider (per spec ch10 §5 step 7), then
#     exit ERROR_INSTALL_FAILURE 1603 to trigger the MSI's automatic
#     rollback transaction (which reverses ServiceInstall and file
#     placement). State directory under %PROGRAMDATA%\ccsm is ALWAYS
#     preserved across rollback (the StateDir component is Permanent
#     unless REMOVEUSERDATA=1 — see win/Product.wxs.template).
#   - On 200: exit 0.
#
# Why named pipe + raw HTTP/1.1: Invoke-WebRequest does not speak named
# pipe transport in Windows PowerShell 5.x or PowerShell 7. We open the
# pipe with [System.IO.Pipes.NamedPipeClientStream] and write a literal
# "GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n", then parse the
# status line. This is a v0.3-locked decision; v0.4 may revisit.
#
# Exit codes:
#   0     /healthz returned 200 within 10s
#   1603  ERROR_INSTALL_FAILURE — triggers MSI rollback transaction
#         (the only failure code the WiX CustomAction propagates).

[CmdletBinding()]
param(
  [int] $TimeoutSeconds      = $(if ($env:CCSM_HEALTHZ_TIMEOUT_SECONDS)      { [int]$env:CCSM_HEALTHZ_TIMEOUT_SECONDS }      else { 10 }),
  [int] $PollIntervalSeconds = $(if ($env:CCSM_HEALTHZ_POLL_INTERVAL_SECONDS) { [int]$env:CCSM_HEALTHZ_POLL_INTERVAL_SECONDS } else { 1 }),
  [int] $LogTailLines        = $(if ($env:CCSM_HEALTHZ_LOG_TAIL_LINES)       { [int]$env:CCSM_HEALTHZ_LOG_TAIL_LINES }       else { 200 }),
  [string] $PipeName         = 'ccsm-supervisor',
  [string] $ForceOutcome     = $env:CCSM_HEALTHZ_FORCE_OUTCOME,
  [switch] $DryRun
)

if ($env:CCSM_HEALTHZ_DRY_RUN) { $DryRun = $true }

$ErrorActionPreference = 'Continue'
$ScriptName            = 'ccsm-healthz'
$ErrorInstallFailure   = 1603

function Write-Log  { param($m) Write-Host  "[$ScriptName] $m" }
function Write-Warn { param($m) Write-Host  "[$ScriptName] WARN: $m" }
function Write-Err  { param($m) [Console]::Error.WriteLine("[$ScriptName] ERROR: $m") }

# Locked spec command (ch10 §5 step 7 — Windows branch).
function Get-ServiceLogCaptureCommand {
  return "Get-WinEvent -LogName Application -MaxEvents $LogTailLines | Where-Object { `$_.ProviderName -like '*ccsm*' }"
}

# Rollback on Windows = exit 1603. The MSI engine reverses the
# ServiceInstall + file placement automatically as part of the
# rollback transaction. State dir component is Permanent (see
# win/Product.wxs.template) so it survives rollback.
function Get-RollbackDescription {
  return "exit ERROR_INSTALL_FAILURE 1603 (MSI rollback transaction reverses install; state dir preserved)"
}

# Probe /healthz over the Supervisor named pipe by writing a raw
# HTTP/1.1 GET and reading the status line. Returns the integer
# status code (e.g., 200, 503), or 0 if the pipe could not be
# reached / no response within the per-probe timeout.
function Invoke-HealthzProbe {
  param(
    [Parameter(Mandatory)] [string] $Pipe,
    [int] $ConnectTimeoutMs = 1000
  )
  $client = $null
  try {
    $client = New-Object System.IO.Pipes.NamedPipeClientStream(
      '.', $Pipe,
      [System.IO.Pipes.PipeDirection]::InOut,
      [System.IO.Pipes.PipeOptions]::None
    )
    $client.Connect($ConnectTimeoutMs)

    $req = "GET /healthz HTTP/1.1`r`nHost: localhost`r`nConnection: close`r`n`r`n"
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
    $client.Write($bytes, 0, $bytes.Length)
    $client.Flush()

    $reader = New-Object System.IO.StreamReader($client, [System.Text.Encoding]::ASCII)
    $statusLine = $reader.ReadLine()
    if (-not $statusLine) { return 0 }

    # Parse "HTTP/1.1 200 OK"
    if ($statusLine -match '^HTTP/\S+\s+(\d{3})\b') {
      return [int]$Matches[1]
    }
    return 0
  } catch {
    return 0
  } finally {
    if ($client) { $client.Dispose() }
  }
}

# ---- forced-outcome short-circuit (unit-test only) ----
if ($DryRun -and $ForceOutcome) {
  switch ($ForceOutcome) {
    'success' {
      Write-Log "DRY-RUN forced outcome=success"
      Write-Log "OK — /healthz returned 200 (simulated)"
      exit 0
    }
    'timeout' {
      Write-Log "DRY-RUN forced outcome=timeout"
      Write-Err "/healthz did not return 200 within ${TimeoutSeconds}s"
      Write-Err ("service log (would run): " + (Get-ServiceLogCaptureCommand))
      Write-Err ("rollback (would run): " + (Get-RollbackDescription))
      Write-Err "state dir preserved (per ch10 §5 step 7)"
      exit $ErrorInstallFailure
    }
    'non200' {
      Write-Log "DRY-RUN forced outcome=non200"
      Write-Err "/healthz returned non-200 (simulated)"
      Write-Err ("service log (would run): " + (Get-ServiceLogCaptureCommand))
      Write-Err ("rollback (would run): " + (Get-RollbackDescription))
      Write-Err "state dir preserved (per ch10 §5 step 7)"
      exit $ErrorInstallFailure
    }
    default {
      Write-Err "unknown CCSM_HEALTHZ_FORCE_OUTCOME=$ForceOutcome"
      exit $ErrorInstallFailure
    }
  }
}

# ---- live path: poll /healthz ----
Write-Log "Supervisor pipe=\\.\pipe\$PipeName timeout=${TimeoutSeconds}s interval=${PollIntervalSeconds}s"

$start    = Get-Date
$deadline = $start.AddSeconds($TimeoutSeconds)
$attempts = 0
$lastStatus = 0

while ((Get-Date) -lt $deadline) {
  $attempts++
  $lastStatus = Invoke-HealthzProbe -Pipe $PipeName -ConnectTimeoutMs 1000

  if ($lastStatus -eq 200) {
    Write-Log "OK — /healthz returned 200 after $attempts attempt(s)"
    exit 0
  }

  Write-Log "attempt ${attempts}: /healthz status=${lastStatus}, retrying in ${PollIntervalSeconds}s"
  Start-Sleep -Seconds $PollIntervalSeconds
}

# ---- failure path ----
Write-Err "/healthz did not return 200 within ${TimeoutSeconds}s (last status=${lastStatus})"

$logCmd = Get-ServiceLogCaptureCommand
Write-Err "capturing last ${LogTailLines} log entries: ${logCmd}"
try {
  $events = Invoke-Expression $logCmd
  foreach ($ev in $events) {
    [Console]::Error.WriteLine($ev | Out-String)
  }
} catch {
  Write-Warn "log capture failed: $($_.Exception.Message) (continuing)"
}

Write-Err ("rolling back: " + (Get-RollbackDescription))
Write-Err "(state directory under %PROGRAMDATA%\ccsm preserved — StateDir component is Permanent)"
exit $ErrorInstallFailure
