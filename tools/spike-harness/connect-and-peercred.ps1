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
      2. GetNamedPipeClientProcessId → pid (server-side semantics: see
         note below — when invoked from the *client* process, we instead
         use GetNamedPipeServerProcessId so this script can be reused as
         a smoke probe; for the canonical §1.1 verification the server
         calls GetNamedPipeClientProcessId on the accepted handle).
      3. OpenProcessToken on pid → resolve SID via GetTokenInformation.
      4. Print one JSON line to stdout, exit 0.

    Output (stdout, single line, JSON):
      {"pipe":"<PipePath>","pid":<int>,"sid":"S-1-5-..","os":"windows"}

    Exit 0 on success; non-zero with error msg on failure.

  T9.1 implementation notes
  -------------------------
  This script is invoked from the *client* side: it CreateFile()s the pipe
  and then asks the kernel "who is on the other end (server)" via
  GetNamedPipeServerProcessId. That is the dual of the server-side
  GetNamedPipeClientProcessId used by `server.ps1` for the peer-cred
  assertion in §1.1 step 5. Both APIs return identical-shape JSON so the
  caller need not care which side it ran on; the field is `pid` of the
  *peer*. P/Invoke uses kernel32!GetNamedPipeServerProcessId +
  advapi32!OpenProcessToken + GetTokenInformation(TokenUser) +
  advapi32!ConvertSidToStringSid.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)] [string] $PipePath
)

$ErrorActionPreference = 'Stop'

$signature = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CcsmPeerCred {
    const uint GENERIC_READ  = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint OPEN_EXISTING = 3;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80;

    const uint TOKEN_QUERY = 0x0008;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    const int TokenUser = 1;

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_USER {
        public SID_AND_ATTRIBUTES User;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeServerProcessId(SafeFileHandle Pipe, out uint ServerProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(SafeFileHandle Pipe, out uint ClientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass,
        IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSidW(IntPtr Sid, out IntPtr StringSid);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    public class Result {
        public uint Pid;
        public string Sid;
        public string PeerRole; // "server" or "client"
    }

    public static Result Probe(string pipePath, bool asServer) {
        SafeFileHandle h;
        if (asServer) {
            // Caller already has the server-side handle (not used in this
            // script — kept for API symmetry).
            throw new InvalidOperationException("server-mode probe must use Probe(SafeFileHandle, true)");
        }
        h = CreateFileW(pipePath, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero,
                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (h.IsInvalid) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),
                "CreateFileW failed for " + pipePath);
        }
        try {
            return ProbeHandle(h, /*asServer*/ false);
        } finally {
            h.Dispose();
        }
    }

    public static Result ProbeHandle(SafeFileHandle h, bool asServer) {
        uint pid;
        if (asServer) {
            // Server-side: who connected to me?
            if (!GetNamedPipeClientProcessId(h, out pid))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetNamedPipeClientProcessId");
        } else {
            // Client-side: who am I talking to?
            if (!GetNamedPipeServerProcessId(h, out pid))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetNamedPipeServerProcessId");
        }
        IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (proc == IntPtr.Zero)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess pid=" + pid);
        try {
            IntPtr tok;
            if (!OpenProcessToken(proc, TOKEN_QUERY, out tok))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken");
            try {
                uint need = 0;
                GetTokenInformation(tok, TokenUser, IntPtr.Zero, 0, out need);
                if (need == 0)
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation sizing");
                IntPtr buf = Marshal.AllocHGlobal((int)need);
                try {
                    if (!GetTokenInformation(tok, TokenUser, buf, need, out need))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation");
                    TOKEN_USER tu = (TOKEN_USER)Marshal.PtrToStructure(buf, typeof(TOKEN_USER));
                    IntPtr sidStr;
                    if (!ConvertSidToStringSidW(tu.User.Sid, out sidStr))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ConvertSidToStringSid");
                    try {
                        return new Result {
                            Pid = pid,
                            Sid = Marshal.PtrToStringUni(sidStr),
                            PeerRole = asServer ? "client" : "server"
                        };
                    } finally {
                        LocalFree(sidStr);
                    }
                } finally {
                    Marshal.FreeHGlobal(buf);
                }
            } finally {
                CloseHandle(tok);
            }
        } finally {
            CloseHandle(proc);
        }
    }
}
'@

Add-Type -TypeDefinition $signature -Language CSharp -ReferencedAssemblies 'System' | Out-Null

try {
    $r = [CcsmPeerCred]::Probe($PipePath, $false)
    $obj = [pscustomobject]@{
        pipe     = $PipePath
        pid      = [int64]$r.Pid
        sid      = $r.Sid
        peerRole = $r.PeerRole
        os       = 'windows'
    }
    $obj | ConvertTo-Json -Compress
    exit 0
} catch {
    Write-Error "$($_.Exception.Message)"
    exit 1
}
