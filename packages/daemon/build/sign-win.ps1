# packages/daemon/build/sign-win.ps1
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §3 (code signing).
#
# Task #82 (T7.3) — per-OS signing scaffolding (placeholder-safe).
#
# Pipeline (per ch10 §3 row "Windows"):
#   For each artifact in {ccsm-daemon.exe, every native\*.node, optional .msi}:
#     signtool sign /fd SHA256 /tr <RFC3161-TSA> /td SHA256 /a /sm
#              /f <PFX> /p <PFX_PASSWORD> /v <artifact>
#
# .msi signing is included as a hook because T9.13 (MSI ServiceInstall, task
# #113 PR #890) lands the WiX build downstream; when an .msi is present in
# dist/ this script signs it the same way. The verify step is owned by T7.9
# (task #80 — verify-signing.ps1).
#
# Placeholder-safe (project_v03_ship_intent): if any required env var is
# missing OR signtool.exe is not on PATH, the script logs a WARN and exits 0.
# Local dogfood builds without an EV cert MUST NOT fail.
#
# Env contract (forever-stable):
#   WIN_CERT_PFX        absolute path to a .pfx code-signing cert. Use an EV
#                       cert for SmartScreen reputation.
#   WIN_CERT_PASSWORD   password for the .pfx. Empty string allowed if the
#                       cert is unprotected (not recommended).
#   WIN_TIMESTAMP_URL   RFC3161 timestamp authority URL. Defaults to
#                       http://timestamp.digicert.com per ch10 §3 example.
#   CCSM_SIGN_DRY_RUN   if "1", print the signtool invocations that WOULD
#                       run and exit 0 without touching artifacts.
#
# Inputs (parameters):
#   -BinaryPath         absolute path to ccsm-daemon.exe
#                       (default: <pkg>\dist\ccsm-daemon.exe)
#   -NativeDir          absolute path to native\ dir
#                       (default: <pkg>\dist\native)
#   -MsiPath            optional absolute path to a .msi to also sign
#                       (default: empty — skip MSI signing).

[CmdletBinding()]
param(
  [string] $BinaryPath = '',
  [string] $NativeDir  = '',
  [string] $MsiPath    = ''
)

$ErrorActionPreference = 'Stop'

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgDir  = (Resolve-Path (Join-Path $Here '..')).Path
$DistDir = Join-Path $PkgDir 'dist'

if (-not $BinaryPath) { $BinaryPath = Join-Path $DistDir 'ccsm-daemon.exe' }
if (-not $NativeDir)  { $NativeDir  = Join-Path $DistDir 'native' }

$DryRun = ($env:CCSM_SIGN_DRY_RUN -eq '1')
$TimestampUrl = if ($env:WIN_TIMESTAMP_URL) { $env:WIN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

function Write-Info($msg) { Write-Host "[sign-win] $msg" }
function Write-Skip($msg) { Write-Warning "[sign-win] $msg" }

# ---- 0. placeholder-safe gate ----
if ($IsLinux -or $IsMacOS) {
  Write-Skip "non-windows host; signtool unavailable. skipping."
  exit 0
}

$missing = @()
if (-not $env:WIN_CERT_PFX)      { $missing += 'WIN_CERT_PFX' }
if ($null -eq $env:WIN_CERT_PASSWORD) { $missing += 'WIN_CERT_PASSWORD' }

if ($missing.Count -gt 0 -and -not $DryRun) {
  Write-Skip ("missing required env: " + ($missing -join ', '))
  Write-Skip 'skipping signing — placeholder-safe behavior for dogfood builds.'
  Write-Skip 'see scripts/sign/README.md for the env-var contract.'
  exit 0
}

# Locate signtool.exe. Windows SDK installs it under several possible roots;
# the most reliable lookup is via the latest installed Windows Kit.
function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kitsRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
  if (Test-Path $kitsRoot) {
    $candidate = Get-ChildItem -Path $kitsRoot -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
  }
  return $null
}

$SignTool = Find-SignTool
if (-not $SignTool -and -not $DryRun) {
  Write-Skip 'signtool.exe not found on PATH or in Windows Kits 10. skipping.'
  Write-Skip '(install Windows SDK or add signtool.exe to PATH for release builds.)'
  exit 0
}

if (-not (Test-Path $BinaryPath) -and -not $DryRun) {
  Write-Skip "daemon binary missing: $BinaryPath. skipping."
  exit 0
}

# Build artifact list: binary + every .node under native\ + optional MSI.
$artifacts = @()
if (Test-Path $BinaryPath) { $artifacts += $BinaryPath }
elseif ($DryRun)            { $artifacts += $BinaryPath }   # show in dry-run

if (Test-Path $NativeDir) {
  $artifacts += (Get-ChildItem -Path $NativeDir -Filter '*.node' -Recurse -ErrorAction SilentlyContinue |
                  ForEach-Object { $_.FullName })
}

if ($MsiPath -and (Test-Path $MsiPath)) {
  $artifacts += $MsiPath
} elseif ($MsiPath -and $DryRun) {
  $artifacts += $MsiPath
}

Write-Info ("signing {0} artifact(s) (timestamp={1})" -f $artifacts.Count, $TimestampUrl)

foreach ($art in $artifacts) {
  $signArgs = @(
    'sign',
    '/fd', 'SHA256',
    '/tr', $TimestampUrl,
    '/td', 'SHA256',
    '/f',  ($env:WIN_CERT_PFX),
    '/p',  ($env:WIN_CERT_PASSWORD),
    '/v',
    $art
  )
  if ($DryRun) {
    Write-Host "[sign-win DRY-RUN] $SignTool $($signArgs -join ' ')"
  } else {
    Write-Info "  signtool sign $art"
    & $SignTool @signArgs
    if ($LASTEXITCODE -ne 0) {
      throw "signtool exited $LASTEXITCODE for $art"
    }
  }
}

Write-Info "OK — signed $($artifacts.Count) artifact(s)"
