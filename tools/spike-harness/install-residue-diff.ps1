<#
.SYNOPSIS
  Diff filesystem + registry state before/after install on Windows.

.DESCRIPTION
  Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
  Used by ch14 §1.16 (installer comparison spike) and ch12 §3 ship-gate (d).

  Contract (FOREVER-STABLE — v0.4 may add params, never rename/remove):

    Usage:
      install-residue-diff.ps1 -Mode snapshot -Path <snapshot-file>
      install-residue-diff.ps1 -Mode diff -Before <before> -After <after> [-Allowlist <file>]

    Snapshot file format (NDJSON, one entry per line):
      {"kind":"file","path":"<abs>","size":<bytes>,"mtime":<unix>,"sha256":"<hex>"}
      {"kind":"reg","path":"HKLM\\...","valueName":"<name>","valueData":"<str>"}

    Roots scanned (forever-stable; v0.4 additive only):
      File: %ProgramFiles%, %ProgramFiles(x86)%, %LocalAppData%, %AppData%
            %ProgramData%
      Reg : HKLM:\SOFTWARE, HKCU:\SOFTWARE, HKLM:\SYSTEM\CurrentControlSet\Services

    Output (diff mode, stdout, JSON):
      {"added":[...],"removed":[...],"modified":[...],
       "addedCount":<int>,"removedCount":<int>,"modifiedCount":<int>}

    Exit 0 on success; 1 if diff non-empty AND no allowlist match;
    2 on usage / IO error.

  TODO: implement walk (Get-ChildItem -Recurse) + Get-FileHash SHA256 + reg
  enumeration when T9.16 lands. Contract above is forever-stable.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet('snapshot', 'diff')] [string] $Mode,
  [string] $Path,
  [string] $Before,
  [string] $After,
  [string] $Allowlist
)

$ErrorActionPreference = 'Stop'

switch ($Mode) {
  'snapshot' {
    if (-not $Path) { Write-Error 'snapshot mode requires -Path'; exit 2 }
    Set-Content -LiteralPath $Path -Value '' -NoNewline
    Write-Warning "TODO: implement when T9.16 lands — would walk roots and write $Path"
    exit 0
  }
  'diff' {
    if (-not $Before -or -not $After) {
      Write-Error 'diff mode requires -Before and -After'
      exit 2
    }
    $result = [pscustomobject]@{
      added         = @()
      removed       = @()
      modified      = @()
      addedCount    = 0
      removedCount  = 0
      modifiedCount = 0
      todo          = 'T9.16'
    }
    $result | ConvertTo-Json -Compress
    exit 0
  }
}
