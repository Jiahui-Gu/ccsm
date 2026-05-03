# build-sea.ps1 — Windows variant of build-sea.sh.
#
# Same 7 steps; uses signtool-free path (no codesign on Windows for the spike).

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$OutDir = Join-Path $PSScriptRoot 'out'
$BinName = 'probe-sea.exe'

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Path $OutDir | Out-Null

Write-Host '[1/7] install devDeps'
npm install --no-audit --no-fund --silent

Write-Host '[2/7] bundle probe.mjs -> probe.bundle.cjs'
npx esbuild probe.mjs `
  --bundle `
  --platform=node `
  --target=node22 `
  --format=cjs `
  --external:better-sqlite3 `
  --external:node:sea `
  --outfile=probe.bundle.cjs

Write-Host '[3/7] generate SEA blob'
node --experimental-sea-config sea-config.json

Write-Host '[4/7] copy node binary'
$NodeBin = (Get-Command node).Source
Copy-Item $NodeBin (Join-Path $OutDir $BinName)

Write-Host '[5/7] postject inject blob'
npx postject (Join-Path $OutDir $BinName) NODE_SEA_BLOB probe.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

Write-Host '[6/7] stage better_sqlite3.node + node_modules next to binary'
$SqliteNode = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
if (-not (Test-Path $SqliteNode)) {
  Write-Error "FAIL: $SqliteNode not found after npm install"
}
Copy-Item $SqliteNode (Join-Path $OutDir 'better_sqlite3.node')
New-Item -ItemType Directory -Path (Join-Path $OutDir 'node_modules') | Out-Null
Copy-Item -Recurse 'node_modules/better-sqlite3' (Join-Path $OutDir 'node_modules/')
foreach ($dep in @('bindings', 'file-uri-to-path')) {
  if (Test-Path "node_modules/$dep") {
    Copy-Item -Recurse "node_modules/$dep" (Join-Path $OutDir 'node_modules/')
  }
}

Write-Host '[7/7] run probe-sea.exe'
& (Join-Path $OutDir $BinName)
if ($LASTEXITCODE -ne 0) {
  Write-Error "probe-sea exited $LASTEXITCODE"
}
