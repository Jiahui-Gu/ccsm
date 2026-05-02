<#
.SYNOPSIS
  Apply an SDDL string to a Windows named-pipe handle.

.DESCRIPTION
  Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
  Used by ch14 §1.1 (peer-cred + named-pipe DACL spike), specifically step 3
  which sets pipe DACL to SDDL `D:(A;;GA;;;SY)(A;;GRGW;;;IU)`.

  Contract (FOREVER-STABLE — v0.4 may add params, never rename/remove):

    Args (named):
      -PipeName <string>   pipe name WITHOUT the `\\.\pipe\` prefix
                           (e.g. "ccsm-spike-1.1")
      -Sddl     <string>   SDDL string (e.g. "D:(A;;GA;;;SY)(A;;GRGW;;;IU)")

    Behavior:
      Open the existing named pipe by full path `\\.\pipe\<PipeName>`,
      convert the SDDL into a SecurityDescriptor, and write it back via
      SetSecurityInfo (DACL_SECURITY_INFORMATION).

    Output (stdout, single line, JSON):
      {"pipe":"\\\\.\\pipe\\<PipeName>","sddl":"<Sddl>","applied":true}

    Exit 0 on success; non-zero with error message on failure.

  TODO: implement when T9.1 (peer-cred spike) lands. Implementation will need
  P/Invoke into advapi32.dll's SetSecurityInfo / ConvertStringSecurityDescriptorToSecurityDescriptor
  because PowerShell's Set-Acl doesn't speak SE_KERNEL_OBJECT for pipe handles.
  The arg shape and output JSON above are forever-stable — implementation
  details below the contract may change.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $PipeName,
  [Parameter(Mandatory = $true)] [string] $Sddl
)

$ErrorActionPreference = 'Stop'

$fullPath = "\\.\pipe\$PipeName"

Write-Error "TODO: implement when T9.1 lands — P/Invoke advapi32!SetSecurityInfo on pipe handle for $fullPath with SDDL $Sddl"
exit 64
