# tools/update-flow/lib/rename-prev.ps1
#
# Atomically back up the existing ccsm-daemon.exe binary and any native\ dir
# to a `.prev` sibling so rollback can restore them.
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8 step 2.
#
# Contract:
#   - InstallRoot param (or env CCSM_INSTALL_ROOT) = directory with the binary
#   - exit 0 = renames done (or no-op if nothing to rename)
#   - exit non-zero = rename failed
#
# Uses Move-Item which is atomic on the same volume on NTFS.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$InstallRoot = $env:CCSM_INSTALL_ROOT
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  # Sketch default for dry-run; real flow gets it from updater env.
  $InstallRoot = 'C:\Program Files\ccsm'
}

function Write-Log($msg) { Write-Host "[rename-prev] $msg" }

function Rename-One($src, $dst) {
  if ($DryRun) {
    Write-Log "DRY-RUN: would rename $src -> $dst (if exists)"
    return
  }
  if (Test-Path -LiteralPath $src) {
    if (Test-Path -LiteralPath $dst) {
      Remove-Item -LiteralPath $dst -Recurse -Force
    }
    Move-Item -LiteralPath $src -Destination $dst -Force
  } else {
    Write-Log "skip (not present): $src"
  }
}

$bin = Join-Path $InstallRoot 'ccsm-daemon.exe'
$binPrev = Join-Path $InstallRoot 'ccsm-daemon.prev.exe'
$native = Join-Path $InstallRoot 'native'
$nativePrev = Join-Path $InstallRoot 'native.prev'

Write-Log "install root: $InstallRoot"
Rename-One $bin $binPrev

if ($DryRun -or (Test-Path -LiteralPath $native)) {
  Rename-One $native $nativePrev
}

exit 0
