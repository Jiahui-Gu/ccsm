# build.ps1 — Node 22 SEA hello-world build harness (Windows).
#
# Contract (forever-stable per spec ch14 §1.B / ch10 §1):
#   Inputs:  none (env:NODE22 optional override)
#   Outputs: dist/sea-hello-win32.exe   produced binary
#            dist/run.log                captured stdout/stderr from executing it
#            dist/build.log              captured build steps
#   Exit:    0 on full pipeline success; non-zero on any failure.
#
# Algorithm per Node 22 SEA docs:
#   1. Locate node22.exe (env:NODE22 or download to .cache\node22\)
#   2. node --experimental-sea-config sea-config.json -> sea-prep.blob
#   3. signtool /unbind would normally strip signatures; for unsigned spike skip.
#   4. copy node.exe -> dist\sea-hello-win32.exe
#   5. npx postject inject blob with NODE_SEA fuse sentinel.
#   6. Run resulting binary, compare stdout to "hello-from-sea-win32".
#
# Layer 1: PowerShell + Invoke-WebRequest + Expand-Archive + node toolchain.

$ErrorActionPreference = 'Continue'   # native CLIs writing to stderr must not abort the script
$PSNativeCommandUseErrorActionPreference = $false
$Here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist  = Join-Path $Here 'dist'
$Cache = Join-Path $Here '.cache'
$NodeVersion = '22.22.2'
$PlatTag     = 'win-x64'
$Stamp       = "node-v$NodeVersion-$PlatTag"

New-Item -ItemType Directory -Force -Path $Dist  | Out-Null
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$BuildLog = Join-Path $Dist 'build.log'
Set-Content -Path $BuildLog -Value "[build] start $(Get-Date -Format o)" -Encoding utf8

function Log($msg) {
  $line = "[build] $msg"
  Write-Host $line
  Add-Content -Path $BuildLog -Value $line -Encoding utf8
}

# ---- 1. locate node22 ----
$Node22 = $env:NODE22
if (-not $Node22) {
  $Node22 = Join-Path $Cache "$Stamp\node.exe"
  if (-not (Test-Path $Node22)) {
    $url = "https://nodejs.org/dist/v$NodeVersion/$Stamp.zip"
    $zip = Join-Path $Cache "$Stamp.zip"
    Log "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Log "extracting $zip"
    Expand-Archive -Path $zip -DestinationPath $Cache -Force
  }
}
if (-not (Test-Path $Node22)) { Log "node22 not found at $Node22"; exit 11 }
$ver = & $Node22 --version
Log "node22=$Node22 ($ver)"

# ---- 2. build sea blob ----
Push-Location $Here
try {
  & $Node22 --experimental-sea-config sea-config.json *>> $BuildLog
  if ($LASTEXITCODE -ne 0) { Log "sea-config build failed rc=$LASTEXITCODE"; exit 12 }
} finally { Pop-Location }
$blob = Join-Path $Here 'sea-prep.blob'
if (-not (Test-Path $blob)) { Log "sea-prep.blob missing"; exit 12 }
Log "blob bytes=$((Get-Item $blob).Length)"

# ---- 3/4. copy node.exe ----
$Out = Join-Path $Dist 'sea-hello-win32.exe'
Copy-Item -Force $Node22 $Out
Log "binary template copied to $Out"

# ---- 5. postject inject ----
$sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
$npx = Join-Path (Split-Path -Parent $Node22) 'npx.cmd'
if (-not (Test-Path $npx)) { $npx = 'npx' }
$args = @($Out, 'NODE_SEA_BLOB', $blob, '--sentinel-fuse', $sentinel, '--overwrite')
Log "postject: $($args -join ' ')"
& $npx --yes postject@1.0.0-alpha.6 @args *>> $BuildLog
if ($LASTEXITCODE -ne 0) { Log "postject failed rc=$LASTEXITCODE"; exit 13 }

$bytes = (Get-Item $Out).Length
Log "final binary bytes=$bytes"

# ---- 6. run ----
$runLog = Join-Path $Dist 'run.log'
& $Out *> $runLog
$rc = $LASTEXITCODE
Log "binary exited rc=$rc"
$out = Get-Content $runLog -Raw
Log "run.log:`n$out"

$expected = 'hello-from-sea-win32'
if ($out -match [regex]::Escape($expected)) {
  Log "OK -- output matches '$expected'"
  exit 0
}
Log "FAIL -- expected '$expected' not found"
exit $rc
