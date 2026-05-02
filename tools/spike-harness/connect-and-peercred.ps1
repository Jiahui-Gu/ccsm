<#
.SYNOPSIS
  Connect to a Windows named pipe and report peer credentials (SID).

.DESCRIPTION
  Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
  Used by ch14 §1.1, §1.4, §1.5 (peer-cred + named-pipe transport spikes
  on Windows).

  Contract (FOREVER-STABLE — v0.4 may add params, never rename/remove):

    Args (positional or named):
      <PipePath>   full pipe path including `\\.\pipe\` prefix
                   (e.g. "\\.\pipe\ccsm-spike-1.1")

    Behavior:
      1. CreateFile on the pipe path (GENERIC_READ | GENERIC_WRITE).
      2. GetNamedPipeClientProcessId → pid.
      3. OpenProcessToken on pid → resolve SID via GetTokenInformation.
      4. Print one JSON line to stdout, exit 0.

    Output (stdout, single line, JSON):
      {"pipe":"<PipePath>","pid":<int>,"sid":"S-1-5-..","os":"windows"}

    Exit 0 on success; non-zero with error msg on failure.

  TODO: implement when T9.1 lands. Will P/Invoke kernel32!GetNamedPipeClientProcessId
  + advapi32!OpenProcessToken / GetTokenInformation. Contract above is forever-stable.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)] [string] $PipePath
)

$ErrorActionPreference = 'Stop'

$result = [pscustomobject]@{
  pipe = $PipePath
  pid  = -1
  sid  = ''
  os   = 'windows'
  todo = 'T9.1'
}
$result | ConvertTo-Json -Compress

Write-Error "TODO: implement when T9.1 lands — P/Invoke kernel32!GetNamedPipeClientProcessId on $PipePath"
exit 64
