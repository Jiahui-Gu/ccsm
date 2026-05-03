$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$build = Join-Path $here "build"
$payload = Join-Path $build "payload"
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path $payload | Out-Null

Write-Host "[wix4] publishing payload..."
$tPayload = Measure-Command {
  dotnet publish (Join-Path $here "payload/payload.csproj") `
    -c Release `
    -o $payload `
    --nologo `
    -v q | Out-Null
}

Write-Host "[wix4] compiling MSI..."
$msi = Join-Path $build "CcsmToolingPick.msi"
$tWix = Measure-Command {
  & wix build (Join-Path $here "Product.wxs") -o $msi | Out-Null
}

$msiSize = (Get-Item $msi).Length
$exeSize = (Get-Item (Join-Path $payload "ccsm-daemon-shape.exe")).Length
Write-Host "[wix4] done"
Write-Host "[wix4] payload exe bytes: $exeSize"
Write-Host "[wix4] msi bytes: $msiSize"
Write-Host "[wix4] dotnet publish seconds: $($tPayload.TotalSeconds)"
Write-Host "[wix4] wix build seconds: $($tWix.TotalSeconds)"
