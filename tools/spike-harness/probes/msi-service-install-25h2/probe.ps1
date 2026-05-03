#!powershell
# T9.13 — install + smoke + uninstall the spike MSI on the local machine.
# MUST be invoked from an elevated PowerShell (or it will UAC-prompt).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$msi = (Resolve-Path build/CcsmSpikeSvc.msi).Path
$installLog   = Join-Path $here 'build/install.log'
$uninstallLog = Join-Path $here 'build/uninstall.log'

Write-Host "[probe] install $msi"
$p = Start-Process -FilePath msiexec.exe `
    -ArgumentList '/i', $msi, '/qn', '/L*v', $installLog `
    -Wait -PassThru -Verb RunAs
Write-Host "[probe] install_exit=$($p.ExitCode)"
if ($p.ExitCode -ne 0) { throw "install failed: $($p.ExitCode)" }

Write-Host '[probe] sc query CcsmSpikeSvc'
sc.exe query CcsmSpikeSvc | Out-Host
sc.exe qc    CcsmSpikeSvc | Out-Host

Write-Host "[probe] uninstall $msi"
$p = Start-Process -FilePath msiexec.exe `
    -ArgumentList '/x', $msi, '/qn', '/L*v', $uninstallLog `
    -Wait -PassThru -Verb RunAs
Write-Host "[probe] uninstall_exit=$($p.ExitCode)"
if ($p.ExitCode -ne 0) { throw "uninstall failed: $($p.ExitCode)" }

Write-Host '[probe] sc query CcsmSpikeSvc (expect 1060)'
$rc = (Start-Process -FilePath sc.exe -ArgumentList 'query','CcsmSpikeSvc' -Wait -PassThru -NoNewWindow).ExitCode
Write-Host "[probe] sc_query_after_uninstall_rc=$rc"
if ($rc -ne 1060) { throw "expected 1060 (ERROR_SERVICE_DOES_NOT_EXIST), got $rc" }

Write-Host '[probe] PASS'
