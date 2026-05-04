# scripts/installer/uninstall.ps1
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.1 (Windows MSI) + chapter 10 §5 step list (Common to
#       all uninstallers, steps 1-6).
# Task: T7.6 (#84) — uninstaller: REMOVEUSERDATA matrix + service unregister.
#
# Top-level Windows uninstaller wrapper. Drives msiexec /x against the
# installed CCSM product. The MSI's WiX 4 <ServiceControl> element handles
# steps 1-2 (stop + remove ccsm-daemon service); the REMOVEUSERDATA public
# property (default 0; set to 1 here when -RemoveUserData is passed)
# drives the StateDirRemovable component which runs <util:RemoveFolderEx>
# against %PROGRAMDATA%\ccsm. See packages/daemon/build/install/win/Product.wxs.template.
#
# Both interactive + silent variants are exposed (spec ch10 §5 step 4):
#
#   -Silent              non-interactive (msiexec /qn). Honours
#                        $env:CCSM_REMOVE_USER_DATA (default 0 = keep).
#                        This is the ship-gate (d) path invoked by
#                        tools/installer-roundtrip.ps1.
#   (default)            interactive — msiexec /qb (basic UI, progress
#                        bar) plus a PowerShell prompt for "remove user
#                        data?" before launching msiexec.
#   -RemoveUserData      force REMOVEUSERDATA=1 from the CLI (overrides
#                        env / prompt).
#   -KeepUserData        force REMOVEUSERDATA=0 from the CLI.
#   -ProductCode <guid>  override product code lookup (for forks). Default:
#                        looked up from the registry by ProductName='CCSM'.
#
# Behaviour matrix (spec ch10 §5):
#   1. Stop service     → MSI <ServiceControl Stop="both">
#   2. Unregister svc   → MSI <ServiceControl Remove="uninstall">
#   3. Remove binaries  → MSI default file-table removal of %PROGRAMFILES%\ccsm
#   4. State decision   → -RemoveUserData / env / prompt → REMOVEUSERDATA=0|1
#   5. If yes           → MSI StateDirRemovable component runs RemoveFolderEx
#                         against %PROGRAMDATA%\ccsm (ch10 §5.1)
#   6. Remove unins.    → MSI default unregisters from Add/Remove Programs
#
# State dir is left untouched unless REMOVEUSERDATA=1 is set. Spec ch10 §5
# step 4: "Default: keep state on uninstall, delete only on explicit
# 'remove user data' tick".
#
# Exit codes:
#   0    uninstall complete (msiexec returned 0 or 3010 reboot-required)
#   1    not running elevated
#   2    no installed product detected
#   3    msiexec returned non-zero non-reboot code
#   4    invalid args

[CmdletBinding()]
param(
    [switch]$Silent,
    [switch]$RemoveUserData,
    [switch]$KeepUserData,
    [string]$ProductCode = '',
    [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'

function Write-Log  { param([string]$M) Write-Host "[ccsm-uninstall] $M" }
function Write-Warn { param([string]$M) Write-Warning "[ccsm-uninstall] $M" }
function Write-Err  { param([string]$M) Write-Error "[ccsm-uninstall] $M" -ErrorAction Continue }

# ---- arg sanity ----
if ($RemoveUserData -and $KeepUserData) {
    Write-Err "cannot pass both -RemoveUserData and -KeepUserData"
    exit 4
}

# ---- elevation check ----
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "must run elevated (right-click PowerShell -> Run as Administrator)"
    exit 1
}

# ---- locate installed product code ----
# Two sources: HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\<guid>
# and the WMI Win32_Product (slow + side-effects: skip). We grep the
# Uninstall key for DisplayName='CCSM'.
function Get-CcsmProductCode {
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($base in $paths) {
        if (-not (Test-Path $base)) { continue }
        $keys = Get-ChildItem $base -ErrorAction SilentlyContinue
        foreach ($k in $keys) {
            $name = $k.Name.Split('\')[-1]
            # Only proper {GUID} keys are MSI products. Skip "_is1" etc.
            if ($name -notmatch '^\{[0-9A-Fa-f-]+\}$') { continue }
            $props = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
            if ($props.DisplayName -eq 'CCSM') {
                return $name
            }
        }
    }
    return $null
}

if ([string]::IsNullOrWhiteSpace($ProductCode)) {
    $ProductCode = Get-CcsmProductCode
    if (-not $ProductCode) {
        Write-Warn "no installed CCSM product detected (DisplayName=CCSM not in Uninstall registry)"
        exit 2
    }
}
Write-Log "product code: $ProductCode"

# ---- decide REMOVEUSERDATA value ----
$removeUserData = '0'
if ($RemoveUserData) {
    $removeUserData = '1'
} elseif ($KeepUserData) {
    $removeUserData = '0'
} elseif ($Silent) {
    # spec ch10 §5 step 4: silent honours env var; default 0 = keep.
    $envVal = $env:CCSM_REMOVE_USER_DATA
    if ($envVal -eq '1') { $removeUserData = '1' } else { $removeUserData = '0' }
} else {
    # Interactive prompt — default no.
    Write-Host ""
    Write-Host "Remove all CCSM user data? This deletes:"
    Write-Host "    %PROGRAMDATA%\ccsm  (sessions, descriptors, ccsm.db)"
    Write-Host ""
    Write-Host "(Default: no, keep user data so a reinstall preserves sessions.)"
    $reply = Read-Host "Remove user data? [y/N]"
    if ($reply -match '^(y|Y|yes|YES)$') { $removeUserData = '1' } else { $removeUserData = '0' }
}

# ---- build msiexec invocation ----
# /x <productcode> uninstall
# REMOVEUSERDATA=0|1 — the public secure property declared in
#   build/install/win/Product.wxs.template <Property Id="REMOVEUSERDATA" Secure="yes">
# /qn (silent, no UI) OR /qb (basic UI, progress bar) — spec ch10 §5
#   step 4: "Windows MSI: msiexec /x ... /qn" for the silent path.
# /norestart — never auto-reboot; we never put files in use that need it.
# /l*v <log> — verbose log, default %TEMP%\ccsm-uninstall-<ts>.log so
#   ship-gate (d) can attach it on failure.
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $LogPath = Join-Path $env:TEMP "ccsm-uninstall-$ts.log"
}

$uiFlag = if ($Silent) { '/qn' } else { '/qb' }

$msiArgs = @(
    '/x', $ProductCode,
    "REMOVEUSERDATA=$removeUserData",
    $uiFlag,
    '/norestart',
    '/l*v', $LogPath
)

Write-Log "msiexec $($msiArgs -join ' ')"
Write-Log "REMOVEUSERDATA=$removeUserData (mode=$(if ($Silent) {'silent'} else {'interactive'}))"
Write-Log "log: $LogPath"

$proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
$rc = $proc.ExitCode

# msiexec exit codes:
#   0     success
#   3010  success, reboot required
#   1605  product not installed (treat as "nothing to do" — exit 2)
#   1602  user cancel
switch ($rc) {
    0    { Write-Log "OK — uninstall complete (REMOVEUSERDATA=$removeUserData)"; exit 0 }
    3010 { Write-Log "OK — uninstall complete; reboot required"; exit 0 }
    1605 { Write-Warn "msiexec reports product not installed (1605)"; exit 2 }
    1602 { Write-Warn "user cancelled (1602)"; exit 3 }
    default {
        Write-Err "msiexec returned $rc — see log: $LogPath"
        exit 3
    }
}
