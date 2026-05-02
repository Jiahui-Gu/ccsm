# 14 — Risks and Spikes

This chapter consolidates every MUST-SPIKE item raised in the preceding chapters, plus residual risks that did not warrant a spike but that the implementer must be aware of. Each MUST-SPIKE has a hypothesis, a validation approach, an explicit kill-criterion (what would force the fallback), and the fallback design. No item is left as "TBD" — every entry has a position.

### 1. MUST-SPIKE register

Format: each row is reproduced from the chapter that introduced it; this chapter is the single index.

#### 1.1 [win-localservice-uds] — Windows LocalService UDS / named pipe reachability
- **From**: [02](./02-process-topology.md) §2.1
- **Hypothesis**: a UDS or named pipe created by LocalService in `%ProgramData%\ccsm\` with explicit DACL granting the interactive user `GENERIC_READ|GENERIC_WRITE` is reachable from a per-user Electron process.
- **Validation**: Win 11 25H2 VM, install service, run Electron from a non-admin user, attempt connect; verify peer-cred returns the interactive user's SID.
- **Kill-criterion**: connect fails OR peer-cred returns LocalService's SID instead of the caller's.
- **Fallback**: bind to `127.0.0.1:<ephemeral-port>` and write port to a user-readable file in `%LOCALAPPDATA%\ccsm\port`; combine with peer-cred via `GetExtendedTcpTable` + PID mapping. Loses native peer-cred fidelity (race window between accept and PID lookup); acceptable on a single-user dev machine.

#### 1.2 [macos-uds-cross-user] — macOS UDS cross-user reachability
- **From**: [02](./02-process-topology.md) §2.2
- **Hypothesis**: `/var/run/ccsm/daemon.sock` with group ACL is reachable from per-user Electron without granting Full Disk Access.
- **Validation**: clean macOS 14+ install, run installer, log in as second user, launch Electron, attempt connect.
- **Kill-criterion**: connect refused with EACCES OR System Integrity Protection blocks the path.
- **Fallback**: per-user UDS at `~/Library/Containers/com.ccsm.electron/Data/ccsm.sock` proxied by a launchd per-user agent. Adds a per-user agent (was not in v0.3 scope); preserves UDS semantics. Escalate to user before adopting.

#### 1.3 [loopback-h2c-on-25h2] — Win 11 25H2 loopback HTTP/2 cleartext
- **From**: [03](./03-listeners-and-transport.md) §4
- **Hypothesis**: `http2.createServer({ allowHTTP1: false })` on `127.0.0.1` works under Win 11 25H2 with default Defender Firewall.
- **Validation**: 25H2 VM, daemon as LocalService, Electron as user, 1-min smoke (Hello + 100 unary RPCs + a server-stream of 10k events).
- **Kill-criterion**: connection refused OR p99 RTT > 50 ms loopback OR stream truncation.
- **Fallback (primary)**: A4 — h2 over named pipe (separate spike [win-h2-named-pipe]). **Fallback (secondary)**: A3 — h2 over TLS+ALPN with per-install self-signed cert in `%PROGRAMDATA%\ccsm\listener-a.crt`, trusted by Electron explicitly via Connect transport's `tls` option (NOT installed in OS root store).

#### 1.4 [uds-h2c-on-darwin-and-linux] — UDS HTTP/2 with Node 22
- **From**: [03](./03-listeners-and-transport.md) §4
- **Hypothesis**: Node 22's `http2.connect` can use a UDS via `createConnection: () => net.createConnection(udsPath)`; full Connect-RPC traffic works.
- **Validation**: 1-hour soak running ship-gate (c) workload over UDS.
- **Kill-criterion**: any disconnect / corruption / stream stall not attributable to test setup.
- **Fallback**: A2 — h2c over loopback TCP on the OS where it fails; OS-asymmetric is acceptable (descriptor-mediated).

#### 1.5 [win-h2-named-pipe] — Windows named pipe + h2
- **From**: [03](./03-listeners-and-transport.md) §4
- **Hypothesis**: Node 22 `http2.createServer` on a `net.Server` bound to a Windows named pipe works for Connect-RPC.
- **Validation**: 25H2 VM, full integration suite over named pipe.
- **Kill-criterion**: stream stalls under load OR API rejects pipe handle.
- **Fallback**: A2 with PID-based peer-cred synthesis (per [03](./03-listeners-and-transport.md) §5).

#### 1.6 [renderer-h2-uds] — Electron renderer over chosen Listener A transport
- **From**: [08](./08-electron-client-migration.md) §4
- **Hypothesis**: Chromium-in-Electron renderer can speak Connect-RPC directly over the chosen transport (UDS or named pipe or loopback TCP) without a main-process proxy.
- **Validation**: smoke each transport from a renderer page.
- **Kill-criterion**: Chromium fetch cannot use UDS / named pipe (this is true today for stock fetch; Connect-node provides a `node:http2` based transport that requires main-process construction OR a polyfill).
- **Fallback**: a plain `http2.Server` bridge in the Electron main process bound to ephemeral loopback TCP; renderer connects to loopback; bridge proxies bytes to the daemon's chosen transport. Bridge speaks Connect (no IPC); ship-gate (a) grep still passes. The bridge is the most-likely-needed adaptation; v0.3 SHOULD ship this bridge for predictability across all OSes.

#### 1.7 [worker-thread-pty-throughput] — PTY worker keeps up
- **From**: [06](./06-pty-snapshot-delta.md) §1
- **Hypothesis**: a Node 22 worker_threads worker with node-pty + xterm-headless ingests claude's burstiest output (≥ 2 MB initial) without dropping or coalescing-with-loss.
- **Validation**: synthetic emitter writes 50 MB of mixed VT in 30s; assert every byte appears in the worker's xterm Terminal state and every delta seq is contiguous.
- **Kill-criterion**: any byte loss OR delta seq gap.
- **Fallback**: child_process per session with raw stdio piping (loses xterm-headless server-side state — would jeopardize ship-gate (c)). Escalate before adopting.

#### 1.8 [snapshot-roundtrip-fidelity] — SnapshotV1 encode → decode → encode is byte-identical
- **From**: [06](./06-pty-snapshot-delta.md) §2
- **Hypothesis**: SnapshotV1 encoded from xterm-headless state X, decoded into a fresh xterm-headless instance Y, re-encoded, produces byte-identical SnapshotV1.
- **Validation**: property-based test with 1000 random VT byte sequences.
- **Kill-criterion**: any byte difference attributable to encoding loss.
- **Fallback**: lower the bar to "rendered text + cursor + style match"; weakens ship-gate (c). Escalate before adopting.

#### 1.9 [better-sqlite3-in-sea] — better-sqlite3 inside Node 22 sea
- **From**: [07](./07-data-and-state.md) §1, [10](./10-build-package-installer.md) §1
- **Hypothesis**: better-sqlite3 (`.node` binary) can be embedded in a Node 22 sea blob and loaded.
- **Validation**: build sea per OS, run `new Database(":memory:")` smoke.
- **Kill-criterion**: load throws OR sea blob does not include the .node file (likely; sea cannot embed natives).
- **Fallback (default expected)**: ship `better-sqlite3.node` alongside the sea executable in `native/`; `require()` via absolute path computed from `process.execPath` (per [10](./10-build-package-installer.md) §2).

#### 1.10 [sea-on-22-three-os] — Node 22 sea works on win/mac/linux
- **From**: [10](./10-build-package-installer.md) §1
- **Hypothesis**: `node --experimental-sea-config` + `postject` produces a working single binary on Win 11 25H2, macOS 14 (arm64+x64), Ubuntu 22.04.
- **Validation**: build minimal hello-world daemon binding Listener A, running Hello, exiting cleanly.
- **Kill-criterion**: build fails OR runtime crash on any target.
- **Fallback**: switch to `pkg` (Vercel; maintenance mode); second fallback is a plain `node + bundle.js + node_modules/` zip with launcher script (loses single-file but ships).

#### 1.11 [node-pty-22] — node-pty on Node 22 ABI
- **From**: [10](./10-build-package-installer.md) §2
- **Hypothesis**: node-pty builds against Node 22 ABI on all six matrix combos.
- **Validation**: prebuildify in CI; smoke-spawn `bash` / `cmd.exe` and read 1 KB.
- **Kill-criterion**: build fails OR PTY behaves incorrectly on any target.
- **Fallback**: pin to known-good Node 22 LTS minor; if a target is broken, ship a `child_process` fallback for that OS only with a feature flag — would weaken ship-gate (c) on that OS — escalate before adopting.

#### 1.12 [better-sqlite3-22-arm64] — better-sqlite3 prebuilds on darwin-arm64 / linux-arm64
- **From**: [10](./10-build-package-installer.md) §2
- **Hypothesis**: prebuilds exist on Node 22 ABI for darwin-arm64 and linux-arm64.
- **Validation**: install in CI matrix, open `:memory:`, run a CREATE+INSERT+SELECT.
- **Kill-criterion**: prebuilds missing AND source build fails in CI.
- **Fallback**: build from source in CI per target; bumps build time; acceptable.

#### 1.13 [macos-notarization-sea] — macOS notarization of a sea binary
- **From**: [10](./10-build-package-installer.md) §3
- **Hypothesis**: a Node sea binary passes Apple notarization with hardened runtime + JIT entitlement.
- **Validation**: notarize a hello-world sea; check stapler.
- **Kill-criterion**: notarization rejected.
- **Fallback**: revert to a notarized .app bundle wrapping a non-sea `node + bundle.js + node_modules/`; loses single-file shape on macOS only.

#### 1.14 [msi-service-install-25h2] — WiX 4 service install on 25H2
- **From**: [10](./10-build-package-installer.md) §5.1
- **Hypothesis**: WiX 4 `<ServiceInstall>` for a sea binary works on Win 11 25H2 with proper SDDL.
- **Validation**: build MSI, install on clean 25H2 VM, verify `Get-Service ccsm-daemon` shows Running.
- **Kill-criterion**: service install fails OR ACL on binary blocks LocalService.
- **Fallback**: PowerShell `New-Service` from a custom action with SDDL programmatically applied via `sc.exe sdset`.

#### 1.15 [watchdog-darwin-approach] — macOS watchdog (defer-OK)
- **From**: [09](./09-crash-collector.md) §6
- **Hypothesis**: launchd `KeepAlive=Crashed` plus periodic in-daemon self-check is sufficient liveness for macOS.
- **Validation**: instrument a hang and verify launchd restarts within 60s.
- **Kill-criterion**: launchd does not restart.
- **Fallback**: live without watchdog on macOS in v0.3; document as v0.4 hardening; do NOT block ship.

### 2. Residual risks (no spike, but flagged)

| Risk | Mitigation |
| --- | --- |
| Connect-es / Connect-node version churn between v0.3 freeze and v0.4 | pin exact versions in `pnpm-lock.yaml`; vendor type definitions if needed |
| xterm-headless API changes mid-v0.3 | pin minor; track upstream; SnapshotV1 codec is independent of xterm internals where it matters (we read its public state API) |
| `claude` CLI argv / stdio contract changes (out of our control) | session record stores `claude_args_json`; on contract change, daemon migration step rewrites recorded args additively |
| Win 11 25H2 fast-ring updates regress firewall behavior | nightly installer-roundtrip catches; rollback is uninstall + downgrade VM image |
| User runs Electron + daemon mismatched versions during update | `Hello.proto_min_version` enforces explicit error with update prompt (per [08](./08-electron-client-migration.md) §6) |
| Disk full → SQLite write fails → session state corruption | write coalescer wraps in try/catch; failure → crash_log entry (best-effort) + session state degraded; reads continue from last good row |

### 3. Spike outputs feed the spec

Spike outcomes that change a chapter's design MUST be reflected by a chapter edit before the impl PR for that area lands. Reviewers (stage 2 of the spec pipeline) MUST cross-check that every MUST-SPIKE in this chapter is either (a) explicitly marked unresolved (acceptable for spike-pending phases) or (b) reflected as a definitive choice in the corresponding chapter section.

### 4. v0.4 delta

- **Add** new MUST-SPIKE register entries for v0.4 items (cloudflared lifecycle, JWT validator perf, web Connect transport over CF Tunnel, iOS connect-swift TLS pinning, etc.) — additive list extension.
- **Unchanged**: every v0.3 spike outcome, the residual risk list (still applies), the cross-check discipline.
