# packages/daemon/build/build-sea.ps1
# Spec ch10 §1 — build the daemon as a Node 22 Single Executable Application
# on Windows (counterpart to build-sea.sh).
#
# Pipeline mirrors build-sea.sh: tsc -> esbuild bundle -> node sea-config ->
# copy node.exe -> postject NODE_SEA_BLOB. Code-signing (T7.3 / task #82) is
# OUT OF SCOPE; native (.node) modules are external (T7.2 / task #83).

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgDir  = (Resolve-Path (Join-Path $Here '..')).Path
$DistDir = Join-Path $PkgDir 'dist'
$SeaCfg  = Join-Path $Here   'sea-config.json'

function Step($msg) { Write-Host "[build-sea] $msg" }

# Step 1: tsc compile.
Step 'tsc compile'
Push-Location $PkgDir
try {
  pnpm run build
  if ($LASTEXITCODE -ne 0) { throw "pnpm run build exited $LASTEXITCODE" }

  if (-not (Test-Path (Join-Path $DistDir 'index.js'))) {
    throw 'dist/index.js missing after tsc'
  }

  # Step 2: esbuild bundle.
  Step 'esbuild bundle'
  npx --yes esbuild dist/index.js `
    --bundle `
    --platform=node `
    --target=node22 `
    --format=cjs `
    --outfile=dist/bundle.cjs `
    --external:better-sqlite3 `
    --external:node-pty `
    --external:*.node
  if ($LASTEXITCODE -ne 0) { throw "esbuild exited $LASTEXITCODE" }

  # Step 3: sea-config -> blob.
  Step 'node --experimental-sea-config'
  node --experimental-sea-config $SeaCfg
  if ($LASTEXITCODE -ne 0) { throw "node --experimental-sea-config exited $LASTEXITCODE" }
  if (-not (Test-Path (Join-Path $DistDir 'sea-prep.blob'))) {
    throw 'dist/sea-prep.blob missing after sea-config'
  }

  # Step 4: copy node.exe.
  $NodePath = (Get-Command node).Source
  $Target   = Join-Path $DistDir 'ccsm-daemon.exe'
  Step "copy node.exe -> $Target"
  Copy-Item -Force $NodePath $Target

  # Step 5: postject. Note: on signed node.exe Windows binaries, postject
  # requires --overwrite to strip the existing signature. Spec ch10 §1
  # leaves the strip + sign step to T7.3 (task #82); we just inject.
  Step 'postject inject NODE_SEA_BLOB'
  npx --yes postject `
    $Target `
    NODE_SEA_BLOB `
    (Join-Path $DistDir 'sea-prep.blob') `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 `
    --overwrite
  if ($LASTEXITCODE -ne 0) { throw "postject exited $LASTEXITCODE" }

  Step "done -> $Target"
  Step '(code-signing handled by T7.3 / task #82, not invoked here)'
}
finally {
  Pop-Location
}
