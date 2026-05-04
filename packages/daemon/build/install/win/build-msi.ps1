# packages/daemon/build/install/win/build-msi.ps1
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.1 (Windows MSI).
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Builds the CCSM Windows MSI from Product.wxs.template by:
#   1. substituting tokens (@CCSM_VERSION@ etc.)
#   2. invoking `wix build` (WiX 4+ CLI) to produce ccsm-setup-<ver>-x64.msi
#
# Placeholder-safe (project_v03_ship_intent): if `wix.exe` is not on PATH OR
# the host is not Windows OR the staged daemon dir is missing, the script
# logs a WARN and exits 0. Local dogfood `npm run build` MUST NOT fail when
# WiX 4 is not installed.
#
# Env contract (forever-stable):
#   CCSM_VERSION              product version (default: package.json version)
#   CCSM_UPGRADE_CODE         stable upgrade GUID. NEVER change across releases.
#                             Default: a fixed GUID baked into this script
#                             (the project's canonical upgrade code).
#   CCSM_MANUFACTURER         display name in Add/Remove Programs.
#                             Default: "ccsm".
#   CCSM_INSTALLER_DRY_RUN    if "1", expand the template and print the wix
#                             invocation that WOULD run; exit 0 without
#                             producing an .msi.
#
# Inputs (parameters):
#   -DaemonDir   absolute path to a directory containing ccsm-daemon.exe and
#                a `native\` subdir. Defaults to <pkg>\dist.
#   -OutputDir   absolute path where ccsm-setup-*.msi is written.
#                Defaults to <pkg>\dist.

[CmdletBinding()]
param(
  [string] $DaemonDir = '',
  [string] $OutputDir = ''
)

$ErrorActionPreference = 'Stop'

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$WinDir  = $Here
$BuildDir= (Resolve-Path (Join-Path $Here '..\..')).Path
$PkgDir  = (Resolve-Path (Join-Path $BuildDir '..')).Path
$DistDir = Join-Path $PkgDir 'dist'

if (-not $DaemonDir) { $DaemonDir = $DistDir }
if (-not $OutputDir) { $OutputDir = $DistDir }

$DryRun = ($env:CCSM_INSTALLER_DRY_RUN -eq '1')

# Canonical upgrade code — DO NOT CHANGE across releases. v0.3.x .. v0.4 .. all
# share this so MajorUpgrade replaces in-place. Override via CCSM_UPGRADE_CODE
# only for downstream forks.
$DefaultUpgradeCode = '5b8c2e6a-3c15-4e64-9f0c-7d1e3a2b9c40'

function Write-Info($msg) { Write-Host "[install-win] $msg" }
function Write-Skip($msg) { Write-Warning "[install-win] $msg" }

# ---- 0. placeholder-safe gate ----
if ($IsLinux -or $IsMacOS) {
  Write-Skip "non-windows host; WiX MSI build skipped."
  Write-Skip "this is expected for local cross-platform dogfood builds."
  exit 0
}

# Resolve version from package.json if not provided.
$Version = if ($env:CCSM_VERSION) { $env:CCSM_VERSION } else {
  $rootPkg = Join-Path (Resolve-Path (Join-Path $PkgDir '..\..')).Path 'package.json'
  if (Test-Path $rootPkg) {
    (Get-Content $rootPkg -Raw | ConvertFrom-Json).version
  } else { '0.0.0' }
}
$UpgradeCode  = if ($env:CCSM_UPGRADE_CODE) { $env:CCSM_UPGRADE_CODE } else { $DefaultUpgradeCode }
$Manufacturer = if ($env:CCSM_MANUFACTURER) { $env:CCSM_MANUFACTURER } else { 'ccsm' }

$DaemonExe = Join-Path $DaemonDir 'ccsm-daemon.exe'
$NativeDir = Join-Path $DaemonDir 'native'

if (-not (Test-Path $DaemonExe) -and -not $DryRun) {
  Write-Skip "daemon binary missing: $DaemonExe. skipping MSI build."
  Write-Skip "(run 'pnpm --filter @ccsm/daemon run build:sea' first.)"
  exit 0
}
if (-not (Test-Path $NativeDir) -and -not $DryRun) {
  Write-Skip "native dir missing: $NativeDir. skipping MSI build."
  exit 0
}

# Locate wix.exe (WiX 4+ unified CLI). Not auto-installed on GitHub windows
# runners; release jobs install it via `dotnet tool install --global wix`.
function Find-Wix {
  $cmd = Get-Command wix.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command wix -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$WixExe = Find-Wix
if (-not $WixExe -and -not $DryRun) {
  Write-Skip "wix.exe not found on PATH. skipping MSI build."
  Write-Skip "(install via: dotnet tool install --global wix)"
  exit 0
}

# ---- 1. token substitution ----
$Template = Join-Path $WinDir 'Product.wxs.template'
if (-not (Test-Path $Template)) {
  throw "missing template: $Template"
}

$HealthzTemplate = Join-Path $WinDir 'HealthzCustomAction.wxs.template'
if (-not (Test-Path $HealthzTemplate)) {
  throw "missing template: $HealthzTemplate"
}

# T7.5: stage post-install-healthz.ps1 next to the daemon binary so the
# WiX <Binary> element's SourceFile resolves at compile time.
$HealthzPs1Src = Join-Path (Split-Path -Parent $WinDir) 'post-install-healthz.ps1'
$HealthzPs1Dst = Join-Path $DaemonDir 'post-install-healthz.ps1'
if (Test-Path $HealthzPs1Src) {
  if (-not $DryRun) {
    Copy-Item -Path $HealthzPs1Src -Destination $HealthzPs1Dst -Force
  }
  Write-Info "staged post-install-healthz.ps1 -> $HealthzPs1Dst"
} else {
  Write-Skip "post-install-healthz.ps1 missing at $HealthzPs1Src; healthz CA will be a stub"
}

$Wxs = Join-Path $OutputDir 'Product.wxs'
$content = Get-Content $Template -Raw
$content = $content -replace '@CCSM_VERSION@',      $Version
$content = $content -replace '@CCSM_UPGRADE_CODE@', $UpgradeCode
$content = $content -replace '@CCSM_DAEMON_DIR@',   ($DaemonDir -replace '\\','\\')
$content = $content -replace '@CCSM_DAEMON_EXE@',   ($DaemonExe -replace '\\','\\')
$content = $content -replace '@CCSM_MANUFACTURER@', $Manufacturer

# Healthz CA fragment.
$HealthzWxs = Join-Path $OutputDir 'HealthzCustomAction.wxs'
$healthzContent = Get-Content $HealthzTemplate -Raw
$healthzContent = $healthzContent -replace '@CCSM_HEALTHZ_PS1@', ($HealthzPs1Dst -replace '\\','\\')

if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
Set-Content -Path $Wxs -Value $content -Encoding UTF8
Set-Content -Path $HealthzWxs -Value $healthzContent -Encoding UTF8
Write-Info "wrote $Wxs (version=$Version)"
Write-Info "wrote $HealthzWxs"

# Stub README.txt next to native\ if a fresh staging dir was passed without
# one — keeps the NativeStub component's File element resolvable.
$NativeReadme = Join-Path $NativeDir 'README.txt'
if (-not (Test-Path $NativeReadme)) {
  if (-not (Test-Path $NativeDir)) {
    if ($DryRun) {
      Write-Info "(dry-run) would create $NativeDir"
    } else {
      New-Item -ItemType Directory -Path $NativeDir -Force | Out-Null
    }
  }
  if (-not $DryRun) {
    Set-Content -Path $NativeReadme `
      -Value "Native modules (.node) live in this directory. Loaded by ccsm-daemon via createRequire(process.execPath/native/). See spec ch10 §2." `
      -Encoding ASCII
  }
}

# ---- 2. wix build ----
$MsiName = "ccsm-setup-$Version-x64.msi"
$MsiPath = Join-Path $OutputDir $MsiName

$wixArgs = @(
  'build',
  $Wxs,
  $HealthzWxs,
  '-arch', 'x64',
  '-ext', 'WixToolset.Util.wixext',
  '-o', $MsiPath
)

if ($DryRun) {
  Write-Info "[install-win DRY-RUN] $WixExe $($wixArgs -join ' ')"
  Write-Info "OK (dry-run)"
  exit 0
}

Write-Info "wix build -> $MsiPath"
& $WixExe @wixArgs
if ($LASTEXITCODE -ne 0) {
  throw "wix build exited $LASTEXITCODE"
}

Write-Info "OK — MSI built: $MsiPath"
