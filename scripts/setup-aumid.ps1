<#
.SYNOPSIS
  Register an AUMID and Start Menu shortcut so Windows Adaptive Toasts route
  to a dev build of CCSM.

.DESCRIPTION
  Windows requires an Application User Model ID (AUMID) registered on a
  Start Menu shortcut before it will route Adaptive Toast notifications.
  In a packaged installer (NSIS) this happens automatically. For ad-hoc
  `npm run dev` runs of CCSM, run this script once per machine so toast
  buttons (Allow / Allow always / Reject) actually appear.

  Idempotent: re-running overwrites the shortcut in place.

.PARAMETER Variant
  Either `prod` (default) or `dev`. Picks the matching AUMID + shortcut
  name pair for dual-install (#891). Explicit -AppId / -ShortcutName
  override this default.

.PARAMETER AppId
  The AUMID string to register. Must match the `appId` passed to
  `Notifier.create` from `electron/main.ts` (`com.ccsm.app` for prod,
  `com.ccsm.app.dev` for dev). Defaults from -Variant if omitted.

.PARAMETER ShortcutName
  Display name of the Start Menu shortcut. Defaults from -Variant
  (`CCSM` for prod, `CCSM Dev` for dev).

.PARAMETER TargetExe
  Absolute path to the .exe Windows should launch when the toast body is
  clicked. Defaults to the bundled Electron executable resolved from
  `node_modules/electron/dist/electron.exe`.

.PARAMETER Arguments
  Extra arguments appended to the shortcut's target. Defaults to the repo
  root so `electron .` picks up the dev entry point.

.NOTES
  Requires Windows PowerShell 5.1+ or PowerShell 7+. Does NOT need to run
  elevated — shortcuts go under the current user's Start Menu.

  Originally vendored from the standalone `@ccsm/notify` package's
  `scripts/setup-aumid.ps1` (v0.1.1).
#>

[CmdletBinding()]
param(
  [ValidateSet('prod', 'dev')]
  [string]$Variant = 'prod',
  [string]$AppId = $null,
  [string]$ShortcutName = $null,
  [string]$TargetExe = $null,
  [string]$Arguments = $null
)

$ErrorActionPreference = 'Stop'

# Dual-install (#891): -Variant picks the AUMID + shortcut name pair so the
# dev build's toasts route to its own Start Menu entry instead of colliding
# with the prod install. Explicit -AppId / -ShortcutName still win.
if (-not $AppId) {
  $AppId = if ($Variant -eq 'dev') { 'com.ccsm.app.dev' } else { 'com.ccsm.app' }
}
if (-not $ShortcutName) {
  $ShortcutName = if ($Variant -eq 'dev') { 'CCSM Dev' } else { 'CCSM' }
}

# Resolve the repo root (parent of /scripts).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir '..')

if (-not $TargetExe) {
  $local = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  if (Test-Path $local) {
    $TargetExe = $local
  }
  else {
    $electron = Get-Command electron -ErrorAction SilentlyContinue
    if ($electron) {
      $TargetExe = $electron.Source
    }
    else {
      throw "Could not find electron.exe. Pass -TargetExe explicitly or run 'npm install' first."
    }
  }
}

if (-not $Arguments) {
  $Arguments = "`"$RepoRoot`""
}

$StartMenu = [Environment]::GetFolderPath('Programs')
$ShortcutPath = Join-Path $StartMenu "$ShortcutName.lnk"

# Idempotency: nuke any prior .lnk so the IPropertyStore writes against a
# fresh shell link. Re-stamping an AUMID onto a shortcut that already has
# one returns HRESULT 0x80070001 ("Incorrect function") from Commit() on
# Windows 10/11 — easier to delete-and-recreate than to mutate in place.
if (Test-Path $ShortcutPath) {
  Remove-Item $ShortcutPath -Force
}

Write-Host "Creating Start Menu shortcut:"
Write-Host "  Path:        $ShortcutPath"
Write-Host "  TargetExe:   $TargetExe"
Write-Host "  Arguments:   $Arguments"
Write-Host "  AUMID:       $AppId"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetExe
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $RepoRoot.Path
$Shortcut.WindowStyle = 1
$Shortcut.Save()

# Stamp the AUMID onto the shortcut. Without this, Windows uses a derived id
# and toasts will silently no-op even with a valid shortcut.
# Reference: https://learn.microsoft.com/windows/win32/shell/appids
$cs = @"
using System;
using System.Runtime.InteropServices;
public static class AumidSetter {
    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint propertyCount);
        [PreserveSig] int GetAt(uint propertyIndex, out PROPERTYKEY key);
        [PreserveSig] int GetValue([In] ref PROPERTYKEY key, IntPtr pv);
        [PreserveSig] int SetValue([In] ref PROPERTYKEY key, IntPtr pv);
        [PreserveSig] int Commit();
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHGetPropertyStoreFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr zeroWorks, uint flags,
        [In] ref Guid riid, out IPropertyStore ppv);

    private const ushort VT_LPWSTR = 31;
    private const int PROPVARIANT_SIZE = 24;

    public static void SetAumid(string shortcutPath, string aumid) {
        Guid IID_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IPropertyStore store;
        int hr = SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, 2 /* GPS_READWRITE */, ref IID_IPropertyStore, out store);
        if (hr != 0) throw new System.ComponentModel.Win32Exception(hr);
        PROPERTYKEY key = new PROPERTYKEY {
            fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            pid = 5
        };
        IntPtr pv = Marshal.AllocCoTaskMem(PROPVARIANT_SIZE);
        IntPtr strPtr = IntPtr.Zero;
        try {
            for (int i = 0; i < PROPVARIANT_SIZE; i++) Marshal.WriteByte(pv, i, 0);
            strPtr = Marshal.StringToCoTaskMemUni(aumid);
            Marshal.WriteInt16(pv, 0, (short)VT_LPWSTR);
            Marshal.WriteIntPtr(pv, 8, strPtr);
            hr = store.SetValue(ref key, pv);
            if (hr != 0) throw new System.ComponentModel.Win32Exception(hr);
            hr = store.Commit();
            if (hr != 0) throw new System.ComponentModel.Win32Exception(hr);
        } finally {
            if (strPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(strPtr);
            Marshal.FreeCoTaskMem(pv);
            Marshal.ReleaseComObject(store);
        }
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'AumidSetter').Type) {
  Add-Type -TypeDefinition $cs -Language CSharp
}

[AumidSetter]::SetAumid($ShortcutPath, $AppId) | Out-Null

Write-Host ""
Write-Host "Done. AUMID '$AppId' is now stamped on '$ShortcutPath'."
Write-Host "Toasts emitted by a process that calls app.setAppUserModelId('$AppId') will now route correctly."
