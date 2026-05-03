#!powershell
# T9.13 — build the spike service exe + MSI from a clean checkout.
# Requires: .NET 10 SDK (or net10.0-compatible), `wix` global tool >= 4.0
# (install via: dotnet tool install --global wix --version 5.0.2).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host '[build] publishing service exe...'
dotnet publish svc/CcsmSpikeSvc.csproj -c Release -o build/svc | Out-Host

Write-Host '[build] compiling MSI...'
New-Item -ItemType Directory -Force -Path build | Out-Null
wix build -arch x64 -o build/CcsmSpikeSvc.msi Product.wxs | Out-Host

Write-Host ('[build] done -> ' + (Resolve-Path build/CcsmSpikeSvc.msi).Path)
