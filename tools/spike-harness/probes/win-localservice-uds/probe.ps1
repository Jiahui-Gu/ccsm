<#
.SYNOPSIS
  T9.1 spike orchestrator -- Win 11 25H2 named-pipe reachability probe.

.DESCRIPTION
  Drives the §1.1 phase-0.5 spike for spec ch14 (Task #103). Two modes:

    -Mode same-user      (default, no admin needed)
        Server runs as the current user; client runs as the current user.
        Validates: pipe transport, DACL application, peer-cred P/Invoke.
        This is the "everything except principal-isolation" half -- it
        proves the *mechanics* on which the LocalService variant depends.

    -Mode localservice   (requires admin)
        Wraps server.mjs as a Windows service under
        `NT AUTHORITY\LocalService` via `tools/spike-harness/wrap-as-localservice.ps1`,
        then connects from the current (non-admin) user session. Validates
        cross-principal reachability -- the actual hypothesis of §1.1.

  Output: writes ./probe-results/<mode>.json with verdict + raw event log.
#>

[CmdletBinding()]
param(
    [ValidateSet('same-user', 'localservice')]
    [string] $Mode = 'same-user',
    [string] $PipeName = 'ccsm-spike-1.1',
    [string] $Sddl = 'D:(A;;GA;;;SY)(A;;GRGW;;;IU)',
    [string] $ServiceName = 'CcsmSpikeT91'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
$harnessRoot = Resolve-Path (Join-Path $here '..\..') | Select-Object -ExpandProperty Path
$resultsDir = Join-Path $here 'probe-results'
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

$serverScript = Join-Path $here 'server.mjs'
$clientScript = Join-Path $here 'client.mjs'
$peerCredScript = Join-Path $harnessRoot 'connect-and-peercred.ps1'
$dacScript = Join-Path $harnessRoot 'set-pipe-dacl.ps1'
$wrapScript = Join-Path $harnessRoot 'wrap-as-localservice.ps1'

$pipePath = "\\.\pipe\$PipeName"

function Stop-Server($proc) {
    if ($null -eq $proc) { return }
    try { $proc.Kill() | Out-Null } catch {}
    try { $proc.WaitForExit(2000) | Out-Null } catch {}
}

function Read-Lines($path) {
    if (Test-Path -LiteralPath $path) {
        return Get-Content -LiteralPath $path -ErrorAction SilentlyContinue
    }
    return @()
}

function Run-SameUser {
    $serverLog = Join-Path $resultsDir 'server.log'
    if (Test-Path $serverLog) { Remove-Item $serverLog -Force }

    Write-Host "[1/4] starting Node server (same user)"
    $proc = Start-Process -FilePath 'node.exe' `
        -ArgumentList @($serverScript, $PipeName) `
        -RedirectStandardOutput $serverLog `
        -RedirectStandardError (Join-Path $resultsDir 'server.err') `
        -PassThru -WindowStyle Hidden

    try {
        # Wait for the "listening" event (up to 5 s)
        $listening = $false
        for ($i = 0; $i -lt 50; $i++) {
            Start-Sleep -Milliseconds 100
            $lines = Read-Lines $serverLog
            if ($lines | Where-Object { $_ -match '"event":"listening"' }) {
                $listening = $true; break
            }
        }
        if (-not $listening) {
            throw "server failed to listen within 5s. server.err: $(Get-Content (Join-Path $resultsDir 'server.err') -Raw -ErrorAction SilentlyContinue)"
        }

        Write-Host "[2/4] applying DACL ($Sddl)"
        $dacOut = & $dacScript -PipeName $PipeName -Sddl $Sddl
        Write-Host "      => $dacOut"

        Write-Host "[3/4] running client"
        $clientOut = & node.exe $clientScript $PipeName
        Write-Host "      => $clientOut"
        $client = $clientOut | ConvertFrom-Json

        Write-Host "[4/4] peer-cred probe (client-side)"
        $peerOut = & $peerCredScript -PipePath $pipePath
        Write-Host "      => $peerOut"
        $peer = $peerOut | ConvertFrom-Json

        $serverEvents = Read-Lines $serverLog | ForEach-Object {
            try { $_ | ConvertFrom-Json } catch { $null }
        } | Where-Object { $_ -ne $null }

        $listenEvent = $serverEvents | Where-Object { $_.event -eq 'listening' } | Select-Object -First 1

        $verdict = if ($client.connected -and $client.received -eq 'OK' -and $peer.pid -eq $listenEvent.serverPid -and $peer.sid -eq $listenEvent.serverSid) {
            'PASS'
        } else { 'FAIL' }

        $reason = if ($verdict -eq 'PASS') {
            'pipe reachable; peer-cred resolved server pid+sid identical to listener self-report'
        } else {
            "client.connected=$($client.connected); client.received='$($client.received)'; peer.pid=$($peer.pid) vs listener.serverPid=$($listenEvent.serverPid); peer.sid=$($peer.sid) vs listener.serverSid=$($listenEvent.serverSid)"
        }

        $result = [pscustomobject]@{
            mode           = 'same-user'
            host           = (Get-CimInstance Win32_OperatingSystem).Caption
            build          = "$([Environment]::OSVersion.Version.Major).$([Environment]::OSVersion.Version.Minor).$([Environment]::OSVersion.Version.Build)"
            timestamp      = (Get-Date).ToString('o')
            pipe           = $pipePath
            sddl           = $Sddl
            sddlApplied    = ($dacOut | ConvertFrom-Json).applied
            client         = $client
            peerCred       = $peer
            serverEvents   = $serverEvents
            verdict        = $verdict
            verdictReason  = $reason
        }
        $jsonPath = Join-Path $resultsDir 'same-user.json'
        $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
        Write-Host ""
        Write-Host "=== VERDICT: $verdict ==="
        Write-Host $reason
        Write-Host "result: $jsonPath"
        if ($verdict -ne 'PASS') { exit 3 }
    } finally {
        Stop-Server $proc
    }
}

function Run-LocalService {
    Write-Host "[localservice mode] requires admin elevation."
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "not running elevated. Re-launch this script from an elevated PowerShell with -Mode localservice."
        exit 64
    }

    # Build a self-contained wrapper exe? For the spike we use srvany / nssm
    # if present, else a PowerShell stub launched via sc.exe. Simplest path:
    # use `cmd.exe /c node server.mjs` as the binPath. NOTE: SCM expects a
    # binary that handles SERVICE_CONTROL_START -- a plain exe will fail with
    # error 1053 ("did not respond to start in timely fashion"), but for the
    # *reachability* test the pipe still binds before SCM gives up, so the
    # pipe exists long enough for the client probe. This is intentional and
    # documented in PROBE-RESULT.md.
    $node = (Get-Command node.exe).Path
    $binPath = "`"$node`" `"$serverScript`" $PipeName"

    Write-Host "[1/5] sc delete (idempotent)"
    & sc.exe delete $ServiceName 2>&1 | Out-Null

    Write-Host "[2/5] sc create + sdset via wrap-as-localservice.ps1"
    # wrap-as-localservice expects a single -BinPath; sc.exe binPath= accepts
    # the full quoted command-line.
    $wrapOut = & $wrapScript -ServiceName $ServiceName -BinPath $binPath `
        -Sddl 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)'
    Write-Host "      => $wrapOut"

    Write-Host "[3/5] sc start (may report 1053 -- non-fatal for reachability test)"
    & sc.exe start $ServiceName 2>&1 | Out-Null

    Write-Host "[4/5] waiting 3s for pipe to bind"
    Start-Sleep -Seconds 3

    Write-Host "[5/5] client connect + peer-cred"
    $clientOut = & node.exe $clientScript $PipeName
    Write-Host "      client => $clientOut"
    $peerOut = & $peerCredScript -PipePath $pipePath
    Write-Host "      peer-cred => $peerOut"

    & sc.exe stop $ServiceName 2>&1 | Out-Null
    & sc.exe delete $ServiceName 2>&1 | Out-Null

    $client = $clientOut | ConvertFrom-Json
    $peer = $peerOut | ConvertFrom-Json
    $myselfSid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    $localServiceSid = 'S-1-5-19'

    # PASS criteria from spec ch14 §1.1 step 5:
    #   client receives OK AND peer-cred returns LocalService SID (S-1-5-19)
    #   from the *server* side (i.e. when the server queries
    #   GetNamedPipeClientProcessId on the accepted handle, it sees the
    #   interactive user -- but our probe runs CLIENT-side so peer.sid is
    #   the SERVER's SID; we expect S-1-5-19).
    $verdict = if ($client.connected -and $client.received -eq 'OK' -and $peer.sid -eq $localServiceSid) {
        'PASS'
    } else { 'FAIL' }

    $result = [pscustomobject]@{
        mode           = 'localservice'
        timestamp      = (Get-Date).ToString('o')
        pipe           = $pipePath
        wrap           = ($wrapOut | ConvertFrom-Json)
        client         = $client
        peerCred       = $peer
        clientSidExpected = $myselfSid
        serverSidExpected = $localServiceSid
        verdict        = $verdict
    }
    $jsonPath = Join-Path $resultsDir 'localservice.json'
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
    Write-Host ""
    Write-Host "=== VERDICT: $verdict ==="
    Write-Host "result: $jsonPath"
    if ($verdict -ne 'PASS') { exit 3 }
}

switch ($Mode) {
    'same-user'    { Run-SameUser }
    'localservice' { Run-LocalService }
}
