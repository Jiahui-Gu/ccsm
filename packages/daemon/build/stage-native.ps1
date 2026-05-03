# packages/daemon/build/stage-native.ps1
#
# Spec ch10 §2 — copy prebuilt native (.node) addons into <out-dir>/ next
# to the sea binary on Windows. Counterpart of stage-native.sh.
#
# Filenames MUST match `SEA_NATIVE_FILENAME` in
# packages/daemon/src/native-loader.ts so the runtime
# `createRequire(process.execPath + '/native/')` picks them up.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $OutDir
)

$ErrorActionPreference = 'Stop'

$Here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgDir = (Resolve-Path (Join-Path $Here '..')).Path

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

function Copy-FirstMatch {
  param(
    [string]   $AddonName,
    [string]   $TargetFilename,
    [string[]] $Candidates
  )
  foreach ($rel in $Candidates) {
    $src = Join-Path $PkgDir $rel
    if (Test-Path $src) {
      Copy-Item -Force $src (Join-Path $OutDir $TargetFilename)
      Write-Host "[stage-native] $AddonName -> $(Join-Path $OutDir $TargetFilename) (from $rel)"
      return $true
    }
  }
  Write-Warning "[stage-native] no .node found for $AddonName; tried:"
  foreach ($rel in $Candidates) { Write-Warning "  - $rel" }
  return $false
}

# Resolve current platform-arch tag the way prebuildify names directories.
$plat = (node -p 'process.platform').Trim()
$arch = (node -p 'process.arch').Trim()
$pa   = "$plat-$arch"

# better-sqlite3 — required.
$bsqOk = Copy-FirstMatch -AddonName 'better-sqlite3' -TargetFilename 'better_sqlite3.node' -Candidates @(
  "node_modules/better-sqlite3/prebuilds/$pa/better-sqlite3.node",
  "node_modules/better-sqlite3/prebuilds/$pa/node.napi.node",
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
)
if (-not $bsqOk) {
  throw '[stage-native] FATAL: better-sqlite3 native binary missing; cannot stage'
}

# node-pty — optional until T4.2 wires the actual spawn path.
if (Test-Path (Join-Path $PkgDir 'node_modules/node-pty')) {
  Copy-FirstMatch -AddonName 'node-pty' -TargetFilename 'pty.node' -Candidates @(
    "node_modules/node-pty/prebuilds/$pa/node-pty.node",
    "node_modules/node-pty/prebuilds/$pa/node.napi.node",
    'node_modules/node-pty/build/Release/pty.node'
  ) | Out-Null
} else {
  Write-Host '[stage-native] node-pty not installed yet (T4.2 hook); skipping pty.node'
}
