# tools/verify-signing.ps1
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §7 (per-OS signature verification — Windows branch).
#
# Task #80 (T7.9) — Windows Authenticode verifier. Companion to T7.3 / #82
# `packages/daemon/build/sign-win.ps1`. Invoked in the `package-win-msi`
# CI job AFTER signtool sign and BEFORE artifact upload.
#
# Per ch10 §7 row "Windows":
#   For each of {ccsm-daemon.exe, native\*.node, ccsm-setup-*.msi}:
#     Get-AuthenticodeSignature <path>
#   Assert:
#     .Status                       -eq 'Valid'
#     .SignerCertificate.Subject    -match 'CN=<expected EV CN>'
#     .TimeStamperCertificate       -ne $null
#   Fail the job if any path is NotSigned / HashMismatch / UnknownError.
#
# Placeholder-safe (project_v03_ship_intent): on a non-Windows host or
# when no artifacts are found, the script logs WARN and exits 0 so local
# dogfood `npm run build` smoke does not break. CI release jobs MUST set
# CCSM_VERIFY_SIGNING_STRICT=1, which flips every "skipped because tool/
# host/env missing" gate into a hard failure. A REAL bad-signature finding
# ALWAYS exits non-zero regardless of strict mode.
#
# Env contract (forever-stable):
#   CCSM_VERIFY_SIGNING_STRICT  if "1", missing tooling / wrong host /
#                               missing inputs are HARD FAILURES (exit 30).
#                               Default 0 = placeholder-safe (exit 0+WARN).
#   CCSM_EXPECTED_CERT_CN       optional substring expected in
#                               SignerCertificate.Subject, e.g. "CCSM Inc".
#                               When unset only Status + TimeStamper checks
#                               run (cert pinning skipped). Set in CI to
#                               pin the release cert against substitution.
#
# Inputs (parameters):
#   -BinaryPath  ccsm-daemon.exe (default: packages\daemon\dist\ccsm-daemon.exe)
#   -NativeDir   native\ dir to scan for *.node (default: <pkg>\dist\native)
#   -MsiPath     optional .msi to verify
#
# Exit codes:
#   0   all verified / placeholder-safe skip (non-strict)
#   20  bad signature found (always hard failure regardless of strict)
#   30  strict mode + missing tooling / wrong host / missing input

[CmdletBinding()]
param(
  [string] $BinaryPath = '',
  [string] $NativeDir  = '',
  [string] $MsiPath    = ''
)

# Do NOT use $ErrorActionPreference = 'Stop' — we want to handle each
# Get-AuthenticodeSignature failure ourselves so we can collect ALL bad
# artifacts before exiting (better CI signal than first-fail-stop).

$Strict       = ($env:CCSM_VERIFY_SIGNING_STRICT -eq '1')
$ExpectedCN   = $env:CCSM_EXPECTED_CERT_CN

$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $Here '..')).Path

if (-not $BinaryPath) {
  $BinaryPath = Join-Path $RepoRoot 'packages\daemon\dist\ccsm-daemon.exe'
}
if (-not $NativeDir) {
  $NativeDir = Join-Path $RepoRoot 'packages\daemon\dist\native'
}

function Write-Info($msg) { Write-Host "[verify-signing] $msg" }
function Write-Warn($msg) { Write-Warning "[verify-signing] $msg" }
function Write-Fail($msg) {
  # Use Write-Host to stderr-equivalent so the FAIL line renders cleanly in
  # CI logs without the ScriptStackTrace wrapper that Write-Error injects.
  [Console]::Error.WriteLine("[verify-signing] FAIL: $msg")
}

# soft-skip: placeholder-safe in dev, hard-fail in CI strict mode.
function Invoke-SoftSkip($reason) {
  if ($Strict) {
    Write-Fail "$reason (CCSM_VERIFY_SIGNING_STRICT=1)"
    exit 30
  }
  Write-Warn $reason
  Write-Warn 'skipping — placeholder-safe (set CCSM_VERIFY_SIGNING_STRICT=1 in CI to enforce).'
  exit 0
}

# Cross-host gate. Get-AuthenticodeSignature only exists on Windows
# PowerShell + pwsh-on-Windows (uses Win32 WinVerifyTrust under the hood).
if ($IsLinux -or $IsMacOS) {
  Invoke-SoftSkip 'non-Windows host; Get-AuthenticodeSignature unavailable.'
}

if (-not (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue)) {
  # Microsoft.PowerShell.Security usually autoloads, but constrained-mode
  # or pwsh-on-non-Windows sessions may not. Try one explicit import before
  # giving up.
  Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue
}
if (-not (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue)) {
  Invoke-SoftSkip 'Get-AuthenticodeSignature cmdlet not available.'
}

# Build the artifact list.
$artifacts = New-Object System.Collections.Generic.List[string]

if (Test-Path -LiteralPath $BinaryPath) {
  $artifacts.Add((Resolve-Path -LiteralPath $BinaryPath).Path)
}

if (Test-Path -LiteralPath $NativeDir) {
  Get-ChildItem -LiteralPath $NativeDir -Filter '*.node' -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { $artifacts.Add($_.FullName) }
}

if ($MsiPath) {
  if (Test-Path -LiteralPath $MsiPath) {
    $artifacts.Add((Resolve-Path -LiteralPath $MsiPath).Path)
  } else {
    Write-Fail "missing --MsiPath input: $MsiPath"
    exit 20
  }
}

if ($artifacts.Count -eq 0) {
  Invoke-SoftSkip "no signed artifacts found (looked for $BinaryPath, $NativeDir\*.node, -MsiPath)"
}

Write-Info ("verifying {0} Windows artifact(s)" -f $artifacts.Count)

$bad = @()
foreach ($art in $artifacts) {
  Write-Info "  Get-AuthenticodeSignature $art"
  $sig = $null
  try {
    $sig = Get-AuthenticodeSignature -LiteralPath $art -ErrorAction Stop
  } catch {
    Write-Fail "Get-AuthenticodeSignature threw for ${art}: $($_.Exception.Message)"
    $bad += $art
    continue
  }

  # Per spec: Status must be Valid.
  if ($sig.Status -ne 'Valid') {
    Write-Fail "$art -> Status=$($sig.Status) (expected Valid). StatusMessage=$($sig.StatusMessage)"
    $bad += $art
    continue
  }

  # Per spec: TimeStamperCertificate must be non-null (RFC3161 timestamp
  # required so the signature outlives the signing cert's expiry).
  if ($null -eq $sig.TimeStamperCertificate) {
    Write-Fail "$art -> missing RFC3161 timestamp (TimeStamperCertificate is null)"
    $bad += $art
    continue
  }

  # Per spec: SignerCertificate.Subject must match expected EV CN.
  # Skipped when CCSM_EXPECTED_CERT_CN is unset (dev / no-pin builds).
  if ($ExpectedCN) {
    $subject = $sig.SignerCertificate.Subject
    if ($subject -notmatch [regex]::Escape($ExpectedCN)) {
      Write-Fail "$art -> SignerCertificate.Subject='$subject' does not contain '$ExpectedCN'"
      $bad += $art
      continue
    }
  }

  Write-Info ("    OK Status=Valid Subject={0}" -f $sig.SignerCertificate.Subject)
}

if ($bad.Count -gt 0) {
  Write-Fail ("{0} artifact(s) failed verification:`n  {1}" -f $bad.Count, ($bad -join "`n  "))
  exit 20
}

Write-Info ("OK -- {0} Windows artifact(s) verified" -f $artifacts.Count)
exit 0
