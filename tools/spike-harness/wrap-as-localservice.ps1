<#
.SYNOPSIS
  Wrap an .exe as a Windows service running under NT AUTHORITY\LocalService
  with a caller-supplied SDDL on the service object.

.DESCRIPTION
  Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
  Used by ch14 §1.1 (peer-cred + named-pipe DACL spike).

  Contract (FOREVER-STABLE — v0.4 may add params, never rename/remove):

    Args (named):
      -ServiceName <string>   service short name passed to `sc create`
      -BinPath     <string>   absolute path to the .exe to wrap
      -Sddl        <string>   SDDL applied via `sc sdset` after create
      [-StartType  <string>]  one of demand|auto|disabled (default: demand)

    Behavior:
      1. `sc create <ServiceName> binPath= "<BinPath>" obj= "NT AUTHORITY\LocalService" type= own start= <StartType>`
      2. `sc sdset <ServiceName> "<Sddl>"`
      3. Exit 0 on success, non-zero with sc.exe stderr on failure.

    Output (stdout, single line, JSON):
      {"service":"<ServiceName>","binPath":"<BinPath>","sddl":"<Sddl>","created":true}

  Idempotent? No — caller is responsible for `sc delete <ServiceName>` first
  if the service already exists. The spike harness wraps this in a
  before/after script per §1.1.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ServiceName,
  [Parameter(Mandatory = $true)] [string] $BinPath,
  [Parameter(Mandatory = $true)] [string] $Sddl,
  [ValidateSet('demand', 'auto', 'disabled')] [string] $StartType = 'demand'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $BinPath)) {
  Write-Error "BinPath not found: $BinPath"
  exit 2
}

# sc.exe arguments are space-sensitive — values MUST follow `key= value`
# with the space after `=`. See ch14 §1.1 step 2.
$createArgs = @(
  'create', $ServiceName,
  'binPath=', $BinPath,
  'obj=', 'NT AUTHORITY\LocalService',
  'type=', 'own',
  'start=', $StartType
)
$createOutput = & sc.exe @createArgs 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "sc create failed: $createOutput"
  exit $LASTEXITCODE
}

$sdsetOutput = & sc.exe sdset $ServiceName $Sddl 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "sc sdset failed: $sdsetOutput"
  exit $LASTEXITCODE
}

$result = [pscustomobject]@{
  service = $ServiceName
  binPath = $BinPath
  sddl    = $Sddl
  created = $true
}
$result | ConvertTo-Json -Compress
