# tools/update-flow/lib/rollback.ps1
#
# Restore the previous binary + native\ from `.prev` siblings and emit a
# crash_log entry with `source=update_rollback` so the user-facing crash
# surface (ch09) sees the failure regardless of whether rollback healthz
# passes.
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8 step 4 (rollback).
#
# `crash_log.source` is an open string set per ch04 §5 / ch09 §1 — adding
# `update_rollback` requires NO sources.ts change. The script appends one
# NDJSON line to `state\crash-raw.ndjson` (same format as packages/daemon/
# src/crash/raw-appender.ts CrashRawEntry); the daemon's boot replay
# imports it on next start.
#
# Contract:
#   - exit 0 = rollback succeeded (renames + crash_raw append both worked)
#   - exit non-zero = rollback failed (manual recovery needed)

[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$InstallRoot = $env:CCSM_INSTALL_ROOT,
  [string]$StateDir = $env:CCSM_STATE_DIR,
  [string]$Reason = 'update healthz failed'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = 'C:\Program Files\ccsm'
}
if ([string]::IsNullOrWhiteSpace($StateDir)) {
  # Mirrors packages/daemon/src/state-dir/paths.ts win32 branch.
  $programData = $env:ProgramData
  if ([string]::IsNullOrWhiteSpace($programData)) { $programData = 'C:\ProgramData' }
  $StateDir = Join-Path $programData 'ccsm'
}

function Write-Log($msg) { Write-Host "[rollback] $msg" }

function Restore-Prev {
  $bin = Join-Path $InstallRoot 'ccsm-daemon.exe'
  $binPrev = Join-Path $InstallRoot 'ccsm-daemon.prev.exe'
  $native = Join-Path $InstallRoot 'native'
  $nativePrev = Join-Path $InstallRoot 'native.prev'

  if ($DryRun) {
    Write-Log "DRY-RUN: would restore $binPrev -> $bin"
    Write-Log "DRY-RUN: would restore $nativePrev -> $native (if present)"
    return
  }

  if (-not (Test-Path -LiteralPath $binPrev)) {
    throw "no previous binary at $binPrev — manual recovery needed"
  }

  if (Test-Path -LiteralPath $bin) { Remove-Item -LiteralPath $bin -Force }
  Move-Item -LiteralPath $binPrev -Destination $bin -Force

  if (Test-Path -LiteralPath $nativePrev) {
    if (Test-Path -LiteralPath $native) { Remove-Item -LiteralPath $native -Recurse -Force }
    Move-Item -LiteralPath $nativePrev -Destination $native -Force
  }
}

function Emit-CrashLog {
  $crashRaw = Join-Path $StateDir 'crash-raw.ndjson'
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $uid = [guid]::NewGuid().ToString().ToLower()
  # Lexicographic-ordered id: base36(ts)-uuid. PS lacks built-in base36 so
  # we use a simple [Convert]::ToString call via per-digit map.
  function ToBase36([long]$n) {
    if ($n -eq 0) { return '0' }
    $digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    $sb = New-Object System.Text.StringBuilder
    while ($n -gt 0) {
      [void]$sb.Insert(0, $digits[[int]($n % 36)])
      $n = [math]::Floor($n / 36)
    }
    return $sb.ToString()
  }
  $tsPart = (ToBase36 $nowMs).PadLeft(9, '0')
  $id = "${tsPart}-${uid}"

  # Build the entry as a hashtable then JSON-serialise to keep escaping safe.
  $entry = [ordered]@{
    id       = $id
    ts_ms    = $nowMs
    source   = 'update_rollback'
    summary  = "update_rollback: $Reason"
    detail   = "installRoot=$InstallRoot"
    labels   = @{ installRoot = "$InstallRoot" }
    owner_id = 'daemon-self'
  }
  $line = $entry | ConvertTo-Json -Compress -Depth 4

  if ($DryRun) {
    Write-Log "DRY-RUN: would append to ${crashRaw}:"
    Write-Log "  $line"
    return
  }

  if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  }
  # Append + newline. Out-File defaults to UTF-16 on legacy PS; force UTF-8
  # no-BOM via [System.IO.File]::AppendAllText to match raw-appender.ts.
  [System.IO.File]::AppendAllText($crashRaw, $line + "`n", [System.Text.Encoding]::UTF8)
}

Write-Log "rollback start (reason: $Reason)"
Restore-Prev
Emit-CrashLog
Write-Log "rollback complete"
exit 0
