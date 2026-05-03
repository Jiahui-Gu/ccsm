<#
.SYNOPSIS
  Ship-gate (d): clean installer round-trip on Win 11 25H2.

.DESCRIPTION
  Implements spec ch12 §4.4 (Ship-gate (d)) — see
  docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md.

  Loops both REMOVEUSERDATA=0 and REMOVEUSERDATA=1 variants. For each
  variant:
    1. Snapshot the file-tree + registry of a clean Win 11 25H2 VM.
    2. Install the MSI silently (`msiexec /i ... /qn`).
    3. Verify the daemon service is running and Supervisor /healthz returns 200.
    4. Smoke a Hello RPC + an Electron smoke session.
    5. Uninstall silently with the variant's REMOVEUSERDATA value.
    6. Snapshot again.
    7. Diff. Anything not on `test/installer-residue-allowlist.txt`
       (plus, for REMOVEUSERDATA=0 only, the variant overlay
        `test/installer-residue-allowlist.removeuserdata-0.txt`) FAILS the
       gate. Diff-based check is fail-closed; missing the allowlist file is
       fatal.

  RUNTIME PRECONDITIONS (real-MSI mode, default):
    - Snapshot-restored fresh Win 11 25H2 VM (runner label
      `self-hosted-win11-25h2-vm`, see tools/runners/README.md).
    - Built MSI artifact at `-MsiPath`.
    - Built test client (`ccsm-test-client.exe`) at `-TestClientPath`.

  STATUS (2026-05): the MSI artifact does NOT exist yet — packaging tasks
  #82 / #81 are blocked. This script ships the orchestrator SHELL with
  clear "FUTURE: invoke MSI" markers. The forever-stable allowlist parser
  logic (Read-AllowlistFile + Test-IsAllowedResidue) is fully implemented
  and exercised today by `tools/test/installer-roundtrip-allowlist.spec.ts`
  and by `-DryRun` mode below (synthetic fixture round-trip).

  When #82 / #81 land, remove the throw in `Invoke-RealRoundtrip` and
  the script becomes the live ship-gate (d) check. The diff/allowlist
  surface intentionally does not change.

.PARAMETER MsiPath
  Path to the CCSM MSI artifact. Required unless -DryRun is set.

.PARAMETER TestClientPath
  Path to a built `ccsm-test-client.exe` that issues a Hello RPC against
  Listener A. Required unless -DryRun / -SkipSmoke.

.PARAMETER ElectronExePath
  Path to the installed `ccsm.exe` (Electron app) for smoke launch.
  Defaults to "$env:ProgramFiles\ccsm\ccsm.exe".

.PARAMETER WorkDir
  Scratch directory for snapshots + logs. Defaults to "C:\install".

.PARAMETER AllowlistPath
  Path to the global residue allowlist. Defaults to
  "test/installer-residue-allowlist.txt" (resolved against repo root).

.PARAMETER VariantAllowlistRoot
  Directory containing variant-overlay allowlists. The file
  "installer-residue-allowlist.removeuserdata-0.txt" inside this dir is
  layered on top of -AllowlistPath when REMOVEUSERDATA=0. Defaults to the
  parent dir of -AllowlistPath.

.PARAMETER DryRun
  Synthetic-fixture mode. Skips real MSI install/uninstall; instead
  builds two temp directories representing pre/post snapshots, asserts
  the diff/allowlist logic flags exactly the residue we expect, and exits.
  Used by CI smoke (no MSI yet) and by `-DryRun` syntax verification.

.PARAMETER SkipSmoke
  Skip the post-install Hello RPC + Electron smoke. For local debugging
  only — CI MUST NOT pass this flag.

.PARAMETER VariantOverride
  Comma-separated subset of {0,1} to run (default "0,1"). For local
  debugging only.

.EXAMPLE
  pwsh tools/installer-roundtrip.ps1 -DryRun

.EXAMPLE
  pwsh tools/installer-roundtrip.ps1 `
    -MsiPath C:\install\ccsm-setup-0.3.0-x64.msi `
    -TestClientPath C:\install\ccsm-test-client.exe

.NOTES
  FOREVER-STABLE per spec ch15: this script's FILE PATH, the
  `Read-AllowlistFile` + `Test-IsAllowedResidue` function names, the
  global+overlay allowlist file paths, and the variant set {0,1} are
  contract. v0.4 may add roots / params / variants additively; never
  rename or remove.
#>

[CmdletBinding()]
param(
  [string] $MsiPath,
  [string] $TestClientPath,
  [string] $ElectronExePath,
  [string] $WorkDir = 'C:\install',
  [string] $AllowlistPath,
  [string] $VariantAllowlistRoot,
  [switch] $DryRun,
  [switch] $SkipSmoke,
  [string] $VariantOverride = '0,1'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

# Repo root = parent of `tools/`. Resolved from $PSScriptRoot so the script
# works regardless of caller CWD (CI, local, snapshot VM).
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot = Resolve-Path (Join-Path $ScriptDir '..') | Select-Object -ExpandProperty Path

if (-not $AllowlistPath) {
  $AllowlistPath = Join-Path $RepoRoot 'test/installer-residue-allowlist.txt'
}
if (-not $VariantAllowlistRoot) {
  $VariantAllowlistRoot = Split-Path -Parent $AllowlistPath
}

# ---------------------------------------------------------------------------
# FOREVER-STABLE: allowlist parser
# ---------------------------------------------------------------------------

function Read-AllowlistFile {
  <#
    Parse a residue allowlist file into an array of regex strings.

    Format (FOREVER-STABLE):
      - One PowerShell-compatible regex per line.
      - Lines starting with '#' are comments; ignored.
      - Blank lines and whitespace-only lines are ignored.
      - Leading/trailing whitespace on each line is trimmed.
      - Inline trailing comments are NOT supported (a `#` mid-line is part
        of the regex). Authors who need a literal '#' in a regex use `\#`.

    Returns an empty array if the file is empty or all-comments. Throws
    [System.IO.FileNotFoundException] if the file does not exist — missing
    allowlist is fatal (fail-closed). To opt out of an allowlist, pass an
    empty file, not a missing one.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [string] $Path
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    throw [System.IO.FileNotFoundException]::new("Allowlist file not found: $Path", $Path)
  }
  $patterns = New-Object System.Collections.Generic.List[string]
  foreach ($raw in (Get-Content -LiteralPath $Path)) {
    $line = $raw.Trim()
    if (-not $line) { continue }
    if ($line.StartsWith('#')) { continue }
    [void]$patterns.Add($line)
  }
  return ,$patterns.ToArray()
}

function Test-IsAllowedResidue {
  <#
    Return $true iff the residue entry matches at least one allowlist
    pattern. Match semantics: PowerShell `-match` (case-insensitive,
    substring-regex). Empty pattern array = nothing is allowed (fail-closed).

    Contract:
      - Pure function; no I/O.
      - Never throws on a malformed pattern: a bad regex is reported via
        Write-Warning and skipped (the gate stays fail-closed for
        well-formed entries).
  #>
  [CmdletBinding()]
  [OutputType([bool])]
  param(
    [Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Entry,
    [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $Patterns
  )
  foreach ($pat in $Patterns) {
    try {
      if ($Entry -match $pat) { return $true }
    } catch {
      Write-Warning "Allowlist pattern is not a valid regex; skipping: $pat ($($_.Exception.Message))"
    }
  }
  return $false
}

function Get-CombinedAllowlist {
  <#
    Compose the effective allowlist for a given REMOVEUSERDATA variant.

    REMOVEUSERDATA=1 (remove user data):  global only.
    REMOVEUSERDATA=0 (keep user data)  :  global + overlay file.

    Variant overlay path:
      <VariantAllowlistRoot>/installer-residue-allowlist.removeuserdata-0.txt

    Missing overlay is fatal in the variant=0 run (matches global file
    semantics); reviewers should never be guessing whether a missing file
    means "intentionally empty" or "deleted by accident".
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [ValidateSet('0','1')] [string] $RemoveUserData,
    [Parameter(Mandatory = $true)] [string] $GlobalPath,
    [Parameter(Mandatory = $true)] [string] $OverlayRoot
  )
  $patterns = [System.Collections.Generic.List[string]]::new()
  $patterns.AddRange([string[]](Read-AllowlistFile -Path $GlobalPath))
  if ($RemoveUserData -eq '0') {
    $overlayPath = Join-Path $OverlayRoot 'installer-residue-allowlist.removeuserdata-0.txt'
    $patterns.AddRange([string[]](Read-AllowlistFile -Path $overlayPath))
  }
  return ,$patterns.ToArray()
}

function Get-Residue {
  <#
    Filter a residue list against an allowlist. Returns the entries that
    are NOT covered by any allowlist pattern (i.e., the things that would
    fail the gate).
  #>
  [CmdletBinding()]
  [OutputType([string[]])]
  param(
    [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $Entries,
    [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $Patterns
  )
  $unallowed = New-Object System.Collections.Generic.List[string]
  foreach ($e in $Entries) {
    if (-not (Test-IsAllowedResidue -Entry $e -Patterns $Patterns)) {
      [void]$unallowed.Add($e)
    }
  }
  return ,$unallowed.ToArray()
}

# ---------------------------------------------------------------------------
# Real-MSI orchestrator (NOT runnable until #82 / #81 land)
# ---------------------------------------------------------------------------

function Invoke-RealRoundtrip {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [ValidateSet('0','1')] [string] $RemoveUserData
  )
  # FUTURE: when #82 (electron-builder MSI) and #81 (daemon sea bin) ship,
  # remove this throw and run the full ch12 §4.4 flow below. The
  # diff/allowlist surface is already in place and exercised in -DryRun.
  throw "Real-MSI ship-gate (d) is blocked on tasks #82 / #81 (MSI artifact + sea binary). " +
        "Run with -DryRun to exercise the diff/allowlist surface. " +
        "When #82/#81 ship, remove this throw and uncomment the body below."

  # ---- ch12 §4.4 pseudo-flow (kept compiling-shaped for future enable) ----
  #
  # Invoke-SnapshotRestore 'win11-25h2-clean'   # provided by win11-runner infra
  #
  # New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  # $fsPre   = Join-Path $WorkDir "fs-pre-$RemoveUserData.txt"
  # $fsPost  = Join-Path $WorkDir "fs-post-$RemoveUserData.txt"
  # $hklmPre = Join-Path $WorkDir "hklm-pre-$RemoveUserData.reg"
  # $hklmPost= Join-Path $WorkDir "hklm-post-$RemoveUserData.reg"
  # $hkcuPre = Join-Path $WorkDir "hkcu-pre-$RemoveUserData.reg"
  # $hkcuPost= Join-Path $WorkDir "hkcu-post-$RemoveUserData.reg"
  # $tasksPre  = Join-Path $WorkDir "tasks-pre-$RemoveUserData.txt"
  # $tasksPost = Join-Path $WorkDir "tasks-post-$RemoveUserData.txt"
  #
  # Get-Snapshot -FsOut $fsPre -HklmOut $hklmPre -HkcuOut $hkcuPre -TasksOut $tasksPre
  #
  # Start-Process -Wait msiexec -ArgumentList @(
  #   '/i', $MsiPath, '/qn', '/l*v', (Join-Path $WorkDir "install-$RemoveUserData.log")
  # )
  #
  # $svc = Get-Service ccsm-daemon
  # if ($svc.Status -ne 'Running') { throw 'service not running post-install' }
  # $listenerA = Get-Content "$env:ProgramData\ccsm\listener-a.json" | ConvertFrom-Json
  # $resp = Invoke-WebRequest -UseBasicParsing $listenerA.healthzUrl
  # if ($resp.StatusCode -ne 200) { throw "supervisor /healthz not 200 (got $($resp.StatusCode))" }
  #
  # if (-not $SkipSmoke) {
  #   & $TestClientPath hello
  #   if ($LASTEXITCODE -ne 0) { throw "Hello RPC smoke failed: exit $LASTEXITCODE" }
  #   $electron = if ($ElectronExePath) { $ElectronExePath } else { "$env:ProgramFiles\ccsm\ccsm.exe" }
  #   & $electron --test-mode --smoke
  #   if ($LASTEXITCODE -ne 0) { throw "Electron smoke failed: exit $LASTEXITCODE" }
  # }
  #
  # Start-Process -Wait msiexec -ArgumentList @(
  #   '/x', $MsiPath, "REMOVEUSERDATA=$RemoveUserData", '/qn',
  #   '/l*v', (Join-Path $WorkDir "uninstall-$RemoveUserData.log")
  # )
  #
  # Get-Snapshot -FsOut $fsPost -HklmOut $hklmPost -HkcuOut $hkcuPost -TasksOut $tasksPost
  #
  # $entries = @()
  # $entries += (Compare-Object (Get-Content $fsPre)    (Get-Content $fsPost)    | Where-Object SideIndicator -eq '=>').InputObject
  # $entries += (Compare-Object (Get-Content $hklmPre)  (Get-Content $hklmPost)  | Where-Object SideIndicator -eq '=>').InputObject
  # $entries += (Compare-Object (Get-Content $hkcuPre)  (Get-Content $hkcuPost)  | Where-Object SideIndicator -eq '=>').InputObject
  # $entries += (Compare-Object (Get-Content $tasksPre) (Get-Content $tasksPost) | Where-Object SideIndicator -eq '=>').InputObject
  #
  # $allow = Get-CombinedAllowlist -RemoveUserData $RemoveUserData -GlobalPath $AllowlistPath -OverlayRoot $VariantAllowlistRoot
  # $residue = Get-Residue -Entries $entries -Patterns $allow
  # if ($residue.Count -gt 0) {
  #   throw "Uninstall residue (REMOVEUSERDATA=$RemoveUserData, not on allowlist):`n$($residue -join "`n")"
  # }
}

function Get-Snapshot {
  <#
    Capture a fs + registry + scheduled-tasks snapshot to four files.
    Wired into Invoke-RealRoundtrip; kept as its own function so a future
    fault-injection variant can call it standalone.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [string] $FsOut,
    [Parameter(Mandatory = $true)] [string] $HklmOut,
    [Parameter(Mandatory = $true)] [string] $HkcuOut,
    [Parameter(Mandatory = $true)] [string] $TasksOut
  )
  $fsRoots = @($env:ProgramFiles, $env:ProgramData, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP)
  Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue $fsRoots `
    | Select-Object -ExpandProperty FullName | Out-File -LiteralPath $FsOut -Encoding utf8
  reg export HKLM $HklmOut /y | Out-Null
  reg export HKCU $HkcuOut /y | Out-Null
  Get-ScheduledTask | Select-Object TaskName, TaskPath `
    | ConvertTo-Csv -NoTypeInformation | Out-File -LiteralPath $TasksOut -Encoding utf8
}

# ---------------------------------------------------------------------------
# DryRun: synthetic-fixture round-trip (no MSI required)
# ---------------------------------------------------------------------------

function Invoke-DryRunRoundtrip {
  <#
    Exercise the diff + allowlist code paths without an MSI. Builds two
    temp "snapshot" file lists with synthetic entries, runs the same
    Get-Residue path the real round-trip uses, and asserts:

      - REMOVEUSERDATA=1 run: ALL CCSM-product residue (e.g. ProgramFiles\ccsm,
        the daemon service registry key, the Uninstall registry key) MUST be
        flagged. OS churn (Defender history, WU datastore) MUST NOT be flagged.
      - REMOVEUSERDATA=0 run: same as above, BUT entries under
        ProgramData\ccsm\crash and ProgramData\ccsm\state and AppData\Roaming\ccsm
        MUST NOT be flagged (overlay covers them).

    This is the smoke that lets us land the script before the MSI exists.
    When the real MSI arrives the same allowlist drives the live gate.
  #>
  [CmdletBinding()]
  param()

  Write-Host '[DryRun] Loading allowlists...'
  $allowR1 = Get-CombinedAllowlist -RemoveUserData '1' -GlobalPath $AllowlistPath -OverlayRoot $VariantAllowlistRoot
  $allowR0 = Get-CombinedAllowlist -RemoveUserData '0' -GlobalPath $AllowlistPath -OverlayRoot $VariantAllowlistRoot
  Write-Host "[DryRun]   variant=1 patterns: $($allowR1.Count)"
  Write-Host "[DryRun]   variant=0 patterns: $($allowR0.Count)"

  # Synthetic post-install diff entries: a mix of OS churn (allowed) and
  # CCSM residue (forbidden). Authored to match real spec-mandated paths.
  $osChurn = @(
    'C:\Windows\SoftwareDistribution\DataStore\Logs\edb0001.log',
    'C:\Windows\System32\LogFiles\WMI\NetCore.etl',
    'C:\ProgramData\Microsoft\Windows Defender\Scans\History\Service\Detections',
    'C:\Users\runner\AppData\Local\IconCache\thumbcache_idx.db'
  )
  $userDataResidue = @(
    'C:\ProgramData\ccsm\crash\2026-05-03T01-23-45.dmp',
    'C:\ProgramData\ccsm\state\sessions.db',
    'C:\Users\runner\AppData\Roaming\ccsm\config.json'
  )
  $forbiddenResidue = @(
    'C:\Program Files\ccsm\ccsm-daemon.exe',
    'C:\Program Files\ccsm\ccsm.exe',
    'HKLM\SYSTEM\CurrentControlSet\Services\ccsm-daemon\ImagePath',
    'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{ccsm-product-guid}\DisplayName',
    'C:\Windows\System32\Tasks\ccsm-updater'
  )

  $allEntries = @() + $osChurn + $userDataResidue + $forbiddenResidue

  # ---- Variant 1: user data MUST be flagged ----
  $r1 = Get-Residue -Entries $allEntries -Patterns $allowR1
  Write-Host "[DryRun] variant=1 residue count: $($r1.Count) (expected: $($userDataResidue.Count + $forbiddenResidue.Count))"
  $expectedR1 = @() + $userDataResidue + $forbiddenResidue
  if ($r1.Count -ne $expectedR1.Count) {
    throw "[DryRun] FAIL variant=1: residue count mismatch.`nGot:`n$($r1 -join "`n")`n`nExpected:`n$($expectedR1 -join "`n")"
  }
  foreach ($e in $expectedR1) {
    if ($r1 -notcontains $e) { throw "[DryRun] FAIL variant=1: missing expected residue entry: $e" }
  }
  foreach ($e in $osChurn) {
    if ($r1 -contains $e) { throw "[DryRun] FAIL variant=1: OS churn was incorrectly flagged: $e" }
  }

  # ---- Variant 0: user data MUST NOT be flagged ----
  $r0 = Get-Residue -Entries $allEntries -Patterns $allowR0
  Write-Host "[DryRun] variant=0 residue count: $($r0.Count) (expected: $($forbiddenResidue.Count))"
  if ($r0.Count -ne $forbiddenResidue.Count) {
    throw "[DryRun] FAIL variant=0: residue count mismatch.`nGot:`n$($r0 -join "`n")`n`nExpected:`n$($forbiddenResidue -join "`n")"
  }
  foreach ($e in $forbiddenResidue) {
    if ($r0 -notcontains $e) { throw "[DryRun] FAIL variant=0: missing expected residue entry: $e" }
  }
  foreach ($e in ($osChurn + $userDataResidue)) {
    if ($r0 -contains $e) { throw "[DryRun] FAIL variant=0: allowed entry was incorrectly flagged: $e" }
  }

  Write-Host '[DryRun] PASS — diff + allowlist surface OK for both variants.'
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# When dot-sourced for testing/REPL ($MyInvocation.InvocationName -eq '.'),
# do not run anything — just expose the functions.
if ($MyInvocation.InvocationName -eq '.') { return }

if ($DryRun) {
  Invoke-DryRunRoundtrip
  exit 0
}

if (-not $MsiPath) {
  Write-Error 'MsiPath is required unless -DryRun is set.'
  exit 2
}

$variants = $VariantOverride.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
foreach ($v in $variants) {
  if ($v -ne '0' -and $v -ne '1') {
    Write-Error "Invalid variant '$v' (must be '0' or '1')"
    exit 2
  }
}

Write-Host "ship-gate (d): variants = $($variants -join ', ')"
foreach ($variant in $variants) {
  Write-Host ""
  Write-Host "==========================================================="
  Write-Host "Variant: REMOVEUSERDATA=$variant"
  Write-Host "==========================================================="
  Invoke-RealRoundtrip -RemoveUserData $variant
}

Write-Host ""
Write-Host "ship-gate (d): PASS"
exit 0
