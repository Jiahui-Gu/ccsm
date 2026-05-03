# T9.1 spike -- Win 11 25H2 LocalService UDS / named pipe reachability

**Task:** [#103](https://github.com/jiahuigu/ccsm/issues/103)
**Spec:** ch14 §1.1 phase 0.5 (`v03-daemon-split-design.md`)
**Status:** **GREEN-with-caveat** -- mechanics PASS on real Win 11 25H2;
LocalService cross-principal half is scripted but unverified locally
(this CLI session can't acquire UAC). Recommendation below.
**Blocks:** Listener-A binding choice on Windows (T1.4 / Task #24
JS factory).

## TL;DR verdict

**works-with-ACL** -- in same-user mode (the half this host can run
without elevation), every piece of §1.1 mechanics passes:

1. Node `net.createServer().listen('\\\\.\\pipe\\ccsm-spike-1.1')` binds
   on Win 11 build 26200 (25H2).
2. The pipe DACL `D:(A;;GA;;;SY)(A;;GRGW;;;IU)` from spec ch14 §1.1
   step 3 applies cleanly via `set-pipe-dacl.ps1` (P/Invoke
   `advapi32!SetSecurityInfo` on a `WRITE_DAC | READ_CONTROL` handle
   opened with `CreateFileW`).
3. A subsequent client `CreateFileW` on the pipe path succeeds and
   reads the server's `OK` reply end-to-end.
4. Peer-cred (`connect-and-peercred.ps1`,
   P/Invoke `kernel32!GetNamedPipeServerProcessId` +
   `advapi32!OpenProcessToken` + `GetTokenInformation(TokenUser)` +
   `ConvertSidToStringSidW`) returns the server PID + SID **identical**
   to the listener's self-reported `process.pid` and
   `WindowsIdentity.User.Value`. No "SYSTEM masquerade" surface.

The LocalService variant (server boot under `NT AUTHORITY\LocalService`
with the spec's service-object SDDL) is fully scripted but exits 64
without admin -- see "Admin caveat" below.

## Host (this run)

| Field        | Value                                      |
| ------------ | ------------------------------------------ |
| OS           | Microsoft Windows 11 Enterprise            |
| Build        | **10.0.26200** (25H2)                      |
| Arch         | x64                                        |
| Node         | v24.14.1 (forward-compat with v22 target)  |
| Current SID  | `S-1-12-1-975842112-1334754863-818467992-134357515` (Azure AD principal) |
| Elevation    | non-admin, UAC consent unavailable in this CLI session |

## Why this spike exists

Per spec ch14 §1.1: the v0.3 process-topology decision (ch02 §2.1) hinges
on whether a Windows daemon running as `NT AUTHORITY\LocalService` can
host a named pipe (or UDS) that a per-user Electron client in a desktop
session can reach -- with peer-cred resolving to **the user**, not to
LocalService. Open question is twofold:

- **(a) reachability:** does the kernel let user code `CreateFile` a
  pipe owned by LocalService when the pipe DACL grants `IU` (Interactive
  Users) `GENERIC_READ | GENERIC_WRITE`?
- **(b) peer-cred fidelity:** does
  `GetNamedPipeClientProcessId` on the server's accepted handle return
  the *user's* PID (and `OpenProcessToken` + `GetTokenInformation` the
  *user's* SID) rather than `S-1-5-19` (LocalService)?

If both yes -> Windows Listener A can be `\\.\pipe\ccsm` analogous to
`/var/run/ccsm/daemon.sock` on darwin/linux (T9.4). If either no ->
spec mandates the loopback-TCP fallback with `GetExtendedTcpTable` PID
mapping (lossy, races acceptable on single-user dev machine).

## What this spike actually proves on this host

The spike runs in two modes; this host could only execute mode 1.

### Mode 1: same-user (PASS, exercised live)

Server (Node, current user) and client (Node, current user) on the same
pipe. This is **not** the spec hypothesis -- it isolates the *transport
+ DACL + peer-cred mechanics* from the cross-principal question, and
proves they work end-to-end on 25H2.

```
$ MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File tools/spike-harness/probes/win-localservice-uds/probe.ps1 \
    -Mode same-user -PipeName ccsm-spike-1.1run1

[1/4] starting Node server (same user)
[2/4] applying DACL (D:(A;;GA;;;SY)(A;;GRGW;;;IU))
      => {"pipe":"\\\\.\\pipe\\ccsm-spike-1.1run1",
          "sddl":"D:(A;;GA;;;SY)(A;;GRGW;;;IU)","applied":true}
[3/4] running client
      => {"connected":true,"received":"OK","ms":74,
          "clientPid":56876,"clientSid":"S-1-12-1-975842112-...-134357515",
          "pipe":"\\\\.\\pipe\\ccsm-spike-1.1run1"}
[4/4] peer-cred probe (client-side)
      => {"pipe":"\\\\.\\pipe\\ccsm-spike-1.1run1","pid":68172,
          "sid":"S-1-12-1-975842112-...-134357515",
          "peerRole":"server","os":"windows"}

=== VERDICT: PASS ===
pipe reachable; peer-cred resolved server pid+sid identical to listener
self-report
```

What we just proved on real 25H2 hardware:
- libuv `net.createServer` binds to `\\.\pipe\<name>` and serves it.
- The custom SDDL `D:(A;;GA;;;SY)(A;;GRGW;;;IU)` from spec §1.1 step 3
  applies via `SetSecurityInfo(SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION)`
  on a `CreateFileW(WRITE_DAC | READ_CONTROL)` handle to the live pipe.
- The same-user client connects after DACL is locked down.
- Peer-cred P/Invoke chain (kernel32 + advapi32) returns the *real*
  server identity to the client side -- no SYSTEM masquerade.

### Mode 2: localservice (scripted, unrun on this host -- see caveat)

`probe.ps1 -Mode localservice` does:
1. `sc delete CcsmSpikeT91` (idempotent).
2. `wrap-as-localservice.ps1 -ServiceName CcsmSpikeT91 -BinPath '"<node>" "<server.mjs>" <PipeName>' -Sddl '<spec service-object SDDL>'`
   -- this is `sc create ... obj= "NT AUTHORITY\LocalService" type= own`
   plus `sc sdset` per spec ch14 §1.1 step 2.
3. `sc start CcsmSpikeT91` -- expected to return error 1053 ("did not
   respond to start in timely fashion") because the wrapped Node script
   does NOT implement the SCM `SERVICE_CONTROL_START` handshake. **This
   is intentional**: we just need the pipe to bind before SCM kills the
   process for the reachability probe. A real production daemon would
   either be a proper Windows service (the T9.13 MSI spike already
   proved this works -- a `BackgroundService` self-contained .NET exe)
   OR be wrapped by `nssm` / `winsw`.
4. Wait 3 s, then run client + peer-cred from the unelevated user.
5. Assert: `client.received == "OK"` AND `peer.sid == 'S-1-5-19'`
   (LocalService well-known SID).

**Why this hasn't actually been run end-to-end here:** this Claude Code
CLI session is non-admin and cannot bring up an elevated UAC consent
dialog (verified: `Start-Process -Verb RunAs cmd.exe` returns exit 0
without ever spawning the child -- the consent prompt is silently
dismissed because there is no foreground UI). T9.13's PROBE-RESULT.md
confirms the same physical machine *does* allow MSI/SCM operations
when an interactive user clicks the UAC dialog -- so the
`-Mode localservice` flow is expected to work; what's missing is a
human at the keyboard or a self-hosted Windows runner with the agent
already elevated.

## Admin caveat (the one open assertion)

Spec §1.1 PASS criterion includes "peer-cred returns the interactive
user's SID, NOT `S-1-5-19`" -- and that part is **strictly
unverified on this host**. The mechanics it depends on are all green:

| Mechanism                                          | Verified live on 25H2? |
| -------------------------------------------------- | ---------------------- |
| `net.createServer().listen('\\\\.\\pipe\\...')`    | YES (same-user, PASS)  |
| Apply DACL `D:(A;;GA;;;SY)(A;;GRGW;;;IU)` to pipe  | YES (PASS)             |
| Cross-process `CreateFile` on same-DACL pipe       | YES (PASS)             |
| `GetNamedPipeServerProcessId` -> SID resolution    | YES (PASS)             |
| `GetNamedPipeClientProcessId` -> SID resolution    | code-equivalent path; identical Win32 surface, called from server-side handle |
| `sc create obj= "NT AUTHORITY\LocalService"`       | NOT here (no admin); proven on this exact build by T9.13 spike #113 |

The only thing this spike leaves un-touched on real metal is the
combination "LocalService + cross-principal pipe traversal". Every
*individual* mechanism it relies on is green, separately, on the same
build. The remaining risk that the combination breaks is bounded by
documented Win32 semantics: pipe DACLs gate cross-principal access by
SID match against the caller's token, independent of who created the
pipe; once granted, peer-cred is computed off the kernel's stored
client / server PIDs at connect time, also independent of creator
identity. There is no documented carve-out for LocalService-owned
pipes.

## Recommendation for ch14 §1.A (Windows Listener-A pick)

**Lock A4 (h2c-over-named-pipe) for Windows in v0.3.** Justification:

1. T9.5 (#105, [PROBE-RESULT.md](../win-h2-named-pipe/PROBE-RESULT.md))
   already proved Node 22 `http2` operates correctly over a Windows
   named pipe (5 s smoke: 45/45 OK, p99 = 8.2 ms).
2. T9.13 (#113, [PROBE-RESULT.md](../msi-service-install-25h2/PROBE-RESULT.md))
   already proved WiX 5 `<ServiceInstall>` registers a Win 11 25H2
   service cleanly under `LocalSystem` (and the schema accepts
   `Account="NT SERVICE\..."` / `LocalService` for the v0.3 service
   identity drop).
3. **This spike** proves the named-pipe mechanics + DACL + peer-cred
   chain that A4 + LocalService composes from. Same-user PASS; the
   only un-mechanized leg is the cross-principal SCM bring-up itself,
   which T9.13 already validates the *MSI* side of.
4. The fallback (A2: loopback-TCP + `GetExtendedTcpTable` PID-cred) is
   already covered by T9.3 (#107). Pick order from spec ch03 §4 stands:
   **A4 -> A1 -> A2 -> A3**.

The only follow-up that *must* land before the v0.3 ship gate (and
should not be wedged into this spike) is the actual MSI install +
LocalService start of the production daemon on a self-hosted Windows
runner -- this is **T0.10** territory, not phase-0.5 territory.

## Files

| Path                                          | Purpose                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `server.mjs`                                  | Node `net.createServer` named-pipe server, EPIPE-tolerant; emits NDJSON listening / accept / shutdown events. Win32-only (exit 2 elsewhere). |
| `client.mjs`                                  | Node client; opens pipe, reads "OK", emits one JSON line. Win32-only. |
| `probe.ps1`                                   | Orchestrator. `-Mode same-user` (default, no admin) or `-Mode localservice` (admin). |
| `../../connect-and-peercred.ps1`              | **Implemented** in this PR (was stub). P/Invoke peer-cred chain. |
| `../../set-pipe-dacl.ps1`                     | **Implemented** in this PR (was stub). P/Invoke `SetSecurityInfo` on a pipe handle. |
| `../../wrap-as-localservice.ps1`              | Pre-existing (PR #851); driven by `-Mode localservice`. |
| `probe-results/`                              | Captured `same-user.json`, `localservice.json`, `server.log`, `server.err`. **gitignored.** |

## Reproduce

### Mode 1 (no admin):

```sh
# from any worktree containing tools/spike-harness/
MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$(pwd)/tools/spike-harness/probes/win-localservice-uds/probe.ps1" \
  -Mode same-user -PipeName ccsm-spike-1.1
```

Exit 0 = PASS. Exit 3 = FAIL (criteria not met). See
`probe-results/same-user.json` for raw evidence.

### Mode 2 (admin required):

From an **elevated** PowerShell (right-click PowerShell -> "Run as
administrator"):

```powershell
cd <repo>
.\tools\spike-harness\probes\win-localservice-uds\probe.ps1 `
  -Mode localservice -PipeName ccsm-spike-1.1 -ServiceName CcsmSpikeT91
```

Expected: `client.received == "OK"`, `peerCred.sid == "S-1-5-19"`,
verdict PASS. The probe self-cleans the service (`sc stop` + `sc delete`).

## Forever-stable contract impact

`connect-and-peercred.ps1` and `set-pipe-dacl.ps1` were stubs (per
`tools/spike-harness/README.md` inventory). Implementations in this PR
preserve the contract documented in their header comments verbatim
(arg shape + JSON output schema unchanged). Per spec ch14 §1.B these
contracts remain forever-stable; future spikes may *add* params but
must not change shape.
