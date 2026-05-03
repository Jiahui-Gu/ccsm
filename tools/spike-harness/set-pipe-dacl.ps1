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
      Open the existing named pipe by full path `\\.\pipe\<PipeName>`
      with WRITE_DAC, convert the SDDL into a SECURITY_DESCRIPTOR via
      ConvertStringSecurityDescriptorToSecurityDescriptorW, extract its
      DACL, then write it back via SetSecurityInfo(handle,
      SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, ..., dacl, ...).

    Output (stdout, single line, JSON):
      {"pipe":"\\\\.\\pipe\\<PipeName>","sddl":"<Sddl>","applied":true}

    Exit 0 on success; non-zero with error message on failure.

  T9.1 implementation note
  ------------------------
  PowerShell's Set-Acl does not speak SE_KERNEL_OBJECT for pipe handles,
  so we P/Invoke directly: advapi32!ConvertStringSecurityDescriptorToSecurityDescriptorW
  + advapi32!GetSecurityDescriptorDacl + advapi32!SetSecurityInfo.
  Opening the pipe with WRITE_DAC requires that the *current* DACL grants
  WRITE_DAC to the caller — which is true when the caller is the pipe's
  owner (the server process). For LocalService-owned pipes called from
  user code, the standard pattern is to bake the SDDL into
  CreateNamedPipeW's SECURITY_ATTRIBUTES at server start; this script is
  retained for the path where the server is a Node `net.createServer`
  that doesn't expose the SECURITY_ATTRIBUTES surface — the server
  process invokes this script (as itself) immediately after the pipe is
  bound but before the client connects.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $PipeName,
  [Parameter(Mandatory = $true)] [string] $Sddl
)

$ErrorActionPreference = 'Stop'

$signature = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CcsmPipeDacl {
    const uint WRITE_DAC = 0x40000;
    const uint READ_CONTROL = 0x20000;
    const uint OPEN_EXISTING = 3;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80;

    // SE_OBJECT_TYPE.SE_KERNEL_OBJECT = 6
    const int SE_KERNEL_OBJECT = 6;
    // SECURITY_INFORMATION.DACL_SECURITY_INFORMATION = 0x4
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    // SDDL revision
    const uint SDDL_REVISION_1 = 1;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string StringSecurityDescriptor, uint StringSDRevision,
        out IntPtr SecurityDescriptor, out uint SecurityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr pSecurityDescriptor,
        out bool lpbDaclPresent, out IntPtr pDacl, out bool lpbDaclDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint SetSecurityInfo(IntPtr handle, int ObjectType,
        uint SecurityInfo, IntPtr psidOwner, IntPtr psidGroup,
        IntPtr pDacl, IntPtr pSacl);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    public static void Apply(string pipePath, string sddl) {
        SafeFileHandle h = CreateFileW(pipePath, WRITE_DAC | READ_CONTROL, 0,
            IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (h.IsInvalid)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),
                "CreateFileW(WRITE_DAC) failed for " + pipePath);
        try {
            IntPtr sd; uint sdSize;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, out sd, out sdSize))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),
                    "ConvertStringSecurityDescriptor failed for SDDL " + sddl);
            try {
                bool present, defaulted;
                IntPtr dacl;
                if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),
                        "GetSecurityDescriptorDacl");
                if (!present)
                    throw new InvalidOperationException("SDDL has no DACL: " + sddl);

                uint err = SetSecurityInfo(h.DangerousGetHandle(), SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
                if (err != 0)
                    throw new System.ComponentModel.Win32Exception((int)err, "SetSecurityInfo failed");
            } finally {
                LocalFree(sd);
            }
        } finally {
            h.Dispose();
        }
    }
}
'@

Add-Type -TypeDefinition $signature -Language CSharp -ReferencedAssemblies 'System' | Out-Null

$fullPath = "\\.\pipe\$PipeName"

try {
    [CcsmPipeDacl]::Apply($fullPath, $Sddl)
    $obj = [pscustomobject]@{
        pipe    = $fullPath
        sddl    = $Sddl
        applied = $true
    }
    $obj | ConvertTo-Json -Compress
    exit 0
} catch {
    Write-Error "$($_.Exception.Message)"
    exit 1
}
