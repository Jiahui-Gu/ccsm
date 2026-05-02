# 14 — Risks and Spikes

This chapter consolidates every MUST-SPIKE item raised in the preceding chapters, plus residual risks that did not warrant a spike but that the implementer must be aware of. Each MUST-SPIKE has a hypothesis, a validation approach, an explicit kill-criterion (what would force the fallback), and the fallback design. No item is left as "TBD" — every entry has a position.

### 1. MUST-SPIKE register

Format: each row is reproduced from the chapter that introduced it; this chapter is the single index.

#### 1.1 [win-localservice-uds] — Windows LocalService UDS / named pipe reachability
- **From**: [02](./02-process-topology.md) §2.1
- **Phase**: blocks phase 0 (transport pick); see [13](./13-release-slicing.md) §Phase 0 / §Phase 0.5.
- **Hypothesis**: a UDS or named pipe created by LocalService in `%ProgramData%\ccsm\` with explicit DACL granting the interactive user `GENERIC_READ|GENERIC_WRITE` is reachable from a per-user Electron process.
- **Validation (repro recipe)**:
  1. Provision Win 11 25H2 build **26100.2314 or later** (firewall behavior settled by this build); use a fresh Hyper-V VM, no domain join, Defender Firewall at default profile.
  2. Build a stripped daemon stub: `node -e "require('net').createServer(s=>s.end('OK')).listen('\\\\.\\pipe\\ccsm-spike-1.1')"` packaged with `tools/spike-harness/wrap-as-localservice.ps1` (see §4 spike harness) which calls `sc create ccsm-spike binPath= "<path>" obj= "NT AUTHORITY\LocalService" type= own start= demand` and `sc sdset ccsm-spike "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"`.
  3. Set the pipe DACL via `tools/spike-harness/set-pipe-dacl.ps1` to SDDL `D:(A;;GA;;;SY)(A;;GRGW;;;IU)`.
  4. Start service (`sc start ccsm-spike`); from a non-admin interactive session run `tools/spike-harness/connect-and-peercred.js \\.\pipe\ccsm-spike-1.1`.
  5. Assert: client receives `OK`; harness's `GetNamedPipeClientProcessId` + `OpenProcessToken` resolves to the interactive user's SID, NOT `S-1-5-19` (LocalService).
- **Kill-criterion**: connect fails (any error) OR peer-cred returns LocalService's SID instead of the caller's OR the harness reports the caller as `SYSTEM`.
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

#### 1.6 [renderer-h2-uds] — RESOLVED (no spike needed)

<!-- F2: closes R5 P1-14-2 / R0 08-P0.3 / R4 P0 ch 14 — transport bridge spike resolved: bridge ships unconditionally per chapter 08 §4.2; renderer-h2-uds is no longer a MUST-SPIKE. -->

- **From**: [08](./08-electron-client-migration.md) §4
- **Status**: **RESOLVED — no spike needed**. Decision (locked across chapters 08 + 14 + 15): the Electron renderer transport bridge ships unconditionally in v0.3 on every OS. Chromium fetch cannot use UDS / named pipe; the bridge speaks loopback TCP to the renderer and forwards Connect to whatever Listener A transport the daemon picked. See chapter [08](./08-electron-client-migration.md) §4.2 for the full bridge spec. The "ship vs. spike" indecision that spanned chapter 08 §4 + chapter 14 §1.6 + chapter 15 §4 item 9 is now a single locked decision; reviewers do not need to audit a spike outcome here.
- **v0.4**: web client uses `connect-web` directly; iOS client uses `connect-swift` directly. Neither goes through the bridge — chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern forbids modifying the bridge for web/iOS reasons.

#### 1.7 [child-process-pty-throughput] — PTY child-process keeps up
- **From**: [06](./06-pty-snapshot-delta.md) §1 (renamed from `[worker-thread-pty-throughput]` after F3 picked the per-session `child_process` boundary; F10 phase 4.5 references this id).
- **Phase**: blocks phase 5 (PTY); see [13](./13-release-slicing.md) §Phase 4.5.
- **Hypothesis**: a Node 22 `child_process` per session running `node-pty` + `xterm-headless` and an IPC channel back to the daemon ingests claude's burstiest output (≥ 2 MB initial code-block dump) without dropping or coalescing-with-loss when received in the daemon main process.
- **Validation (repro recipe)**:
  1. Workload classes (reuse [06](./06-pty-snapshot-delta.md) §8 enumeration verbatim — do NOT invent new classes here): (W1) ASCII-heavy code dump 50 MB / 30s, (W2) heavy SGR colour churn 20 MB / 30s, (W3) alt-screen TUI (htop-replay corpus) 10 MB / 60s, (W4) DECSTBM scroll-region churn 10 MB / 30s, (W5) mixed UTF-8/CJK + combiners 5 MB / 30s, (W6) resize-during-burst (SIGWINCH every 500ms during W1).
  2. Use `tools/spike-harness/pty-emitter.js` to drive each workload through `node-pty` spawn of `bash -c 'cat <fixture>'` (mac/linux) or `cmd /c type <fixture>` (Windows).
  3. Use `tools/spike-harness/delta-collector.js` on the daemon side to capture every delta frame; assert (a) `seq` is contiguous (no gaps), (b) the concatenation of delta byte-payloads equals the SHA256 of the input fixture, (c) the child's xterm-headless `Terminal` final state SnapshotV1 byte-equals a reference snapshot generated by re-feeding the fixture into a fresh xterm-headless instance.
  4. Run each workload 3× back-to-back in the same child process (exercise reuse + GC); the kill criterion applies across all 18 runs.
- **Kill-criterion**: any byte loss (SHA mismatch in (b)) OR any `seq` gap OR snapshot byte-mismatch in (c) OR the child process RSS grows monotonically across the 3 reuses (>20% per cycle).
- **Fallback (real design rework, no escalation needed for go/no-go)**: tighten the segmentation cadence (16 ms / 16 KiB → 8 ms / 8 KiB) and apply zstd compression to delta payloads on the IPC channel (snapshots are already zstd-compressed per §2). If still failing, switch the IPC transport between child and daemon from `process.send` (V8-serialized) to a UDS / named-pipe with framed binary protocol; this is an additive optimization (no proto change). Rework cost: ~2 days; ship-gate (c) unaffected.

#### 1.8 [snapshot-roundtrip-fidelity] — SnapshotV1 encode → decode → encode is byte-identical
- **From**: [06](./06-pty-snapshot-delta.md) §2
- **Phase**: blocks phase 5 (PTY); see [13](./13-release-slicing.md) §Phase 4.5.
- **Hypothesis**: SnapshotV1 encoded from xterm-headless state X, decoded into a fresh xterm-headless instance Y, re-encoded, produces byte-identical SnapshotV1.
- **Validation (repro recipe)**:
  1. Corpus sources (combine; no random uint8 alphabet — that produces ~0% useful sequences):
     - (C1) the xterm.js upstream test fixture corpus at `xterm/test/data/*.in.txt` (covers SGR / cursor / DECSTBM / charset / mouse).
     - (C2) hand-crafted grammar at `tools/spike-harness/vt-grammar.js`: weighted generator producing valid CSI / OSC / DCS sequences with parameter ranges sampled from the `xterm-parser-spec` table; 1000 sequences each of lengths 16, 256, 4096 bytes.
     - (C3) replay corpus from chapter [06](./06-pty-snapshot-delta.md) §8 workload classes (W1–W6 above).
  2. For each input s in C1 ∪ C2 ∪ C3: build xterm-headless `Terminal` X, feed s, encode → snap1; decode snap1 into fresh `Terminal` Y, encode Y → snap2; assert `Buffer.compare(snap1, snap2) === 0`.
  3. Use `tools/spike-harness/snapshot-roundtrip.spec.ts` as the property runner (fast-check or custom).
- **Kill-criterion**: any byte difference attributable to encoding loss on any input from C1 ∪ C2 ∪ C3.
- **Fallback (real design rework)**: lower SnapshotV1 contract to "rendered text + cursor position + per-cell foreground/background/bold/italic/underline match"; drop the (a) palette ordering invariant and (b) `modes_bitmap` fidelity from the contract; add `Snapshot.fidelity_class` enum (`STRICT_BYTE` vs `RENDERED_EQUIVALENT`) to the proto; daemon advertises the fidelity it shipped via `Hello.snapshot_fidelity`. Ship-gate (c) downgrades to `RENDERED_EQUIVALENT` mode (acceptable: dogfood metric (c) is "session feels intact after re-attach", not strict bytewise replay). Rework cost: ~3 days; chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern "SnapshotV1 binary layout locked" remains intact because the on-wire layout is unchanged — only the semantic contract weakens.

#### 1.9 [better-sqlite3-in-sea] — better-sqlite3 inside Node 22 sea
- **From**: [07](./07-data-and-state.md) §1, [10](./10-build-package-installer.md) §1
- **Hypothesis**: better-sqlite3 (`.node` binary) can be embedded in a Node 22 sea blob and loaded.
- **Validation**: build sea per OS, run `new Database(":memory:")` smoke.
- **Kill-criterion**: load throws OR sea blob does not include the .node file (likely; sea cannot embed natives).
- **Fallback (default expected)**: ship `better-sqlite3.node` alongside the sea executable in `native/`; `require()` via absolute path computed from `process.execPath` (per [10](./10-build-package-installer.md) §2).

#### 1.10 [sea-on-22-three-os] — Node 22 sea works on win/mac/linux
- **From**: [10](./10-build-package-installer.md) §1
- **Phase**: blocks phase 10 (build); see [13](./13-release-slicing.md) §Phase 9.5.
- **Hypothesis**: `node --experimental-sea-config` + `postject` produces a working single binary on Win 11 25H2, macOS 14 (arm64+x64), Ubuntu 22.04.
- **Validation (repro recipe)** — runs in phase 0 BEFORE phase 1 proto exists, so the hello-world is proto-free:
  1. Source: `tools/spike-harness/sea-hello/` containing a single `index.js`: `require('net').createServer(s=>s.end('OK\n')).listen(0,()=>{const a=process.argv[1];require('fs').writeFileSync(a,JSON.stringify({port:server.address().port}));})`. The harness binds an ephemeral TCP port (no Listener-A code, no proto, no peer-cred — those depend on phase 1+) and writes the port to a path passed as argv.
  2. `sea-config.json`: `{ "main": "index.js", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true }`.
  3. Build per OS: `node --experimental-sea-config sea-config.json` → `npx postject <node-binary-copy> NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 [--macho-segment-name NODE_SEA on macOS]` → strip + sign (codesign mac, signtool win, no-op linux).
  4. Smoke: run binary with `<tmp>/port.json` argv; `curl http://127.0.0.1:<port>/` returns `OK`; binary exits cleanly when sent SIGTERM (loopback connect succeeds → script's `server.close()` fires).
  5. Targets: Win 11 25H2 build 26100.2314+ (x64), macOS 14.5 (arm64 AND x64 separate builds), Ubuntu 22.04 LTS (x64). Each target runs the smoke 3× (cold + 2 warm).
- **Kill-criterion**: build fails OR binary exits non-zero OR loopback smoke fails OR runtime crash on any target.
- **Fallback**: switch to `pkg` (Vercel; maintenance mode); second fallback is a plain `node + bundle.js + node_modules/` zip with launcher script (loses single-file but ships); pin source-build CI budget bump to **<+5 min** per OS for the zip variant. See chapter [10](./10-build-package-installer.md) §1 cross-link to fallback options.

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
- **Phase**: blocks phase 10 (build/notarization); see [13](./13-release-slicing.md) §Phase 9.5 — and ops prereq blocks phase 0.
- **Hypothesis**: a Node sea binary passes Apple notarization with hardened runtime + JIT entitlement.
- **Ops prereq (must be in place by phase 0, NOT phase 10)**: Apple Developer ID Application certificate provisioned in the project Apple Developer team; certificate + private key installed in the macOS notarization runner's keychain (CI self-hosted mac runner OR a designated maintainer's machine); `notarytool` API key (or app-specific password) stored in `~/.zsh-secrets/ccsm-notarytool.env` (operator-managed, NOT in repo). Pin the prereq owner in chapter [11](./11-monorepo-layout.md) §6 (CI matrix); spike cannot start until prereq closed.
- **Validation (repro recipe)**:
  1. Build the §1.10 hello-world sea on macOS 14.5 arm64.
  2. Sign: `codesign --sign "Developer ID Application: <team-name> (<team-id>)" --options runtime --entitlements tools/spike-harness/entitlements-jit.plist --timestamp <binary>`. Entitlements file MUST grant `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory` (Node JIT).
  3. Zip: `ditto -c -k --keepParent <binary> hello-sea.zip`.
  4. Submit: `xcrun notarytool submit hello-sea.zip --keychain-profile ccsm-notarytool --wait`.
  5. On success: `xcrun stapler staple <binary>`; assert `xcrun stapler validate <binary>` returns `The validate action worked!`; assert `spctl --assess --type execute -vv <binary>` returns `accepted, source=Notarized Developer ID`.
- **Kill-criterion**: notarization rejected (any reason; capture and pin the rejection log path) OR stapler / spctl fails post-staple.
- **Fallback**: revert to a notarized .app bundle wrapping a non-sea `node + bundle.js + node_modules/`; loses single-file shape on macOS only. See chapter [10](./10-build-package-installer.md) §1 / §3 cross-link for the bundle variant.

#### 1.14 [msi-service-install-25h2] — WiX 4 service install on 25H2
- **From**: [10](./10-build-package-installer.md) §5.1
- **Hypothesis**: WiX 4 `<ServiceInstall>` for a sea binary works on Win 11 25H2 with proper SDDL.
- **Validation**: build MSI, install on clean 25H2 VM, verify `Get-Service ccsm-daemon` shows Running.
- **Kill-criterion**: service install fails OR ACL on binary blocks LocalService.
- **Fallback**: PowerShell `New-Service` from a custom action with SDDL programmatically applied via `sc.exe sdset`.

#### 1.15 [watchdog-darwin-approach] — REMOVED from MUST-SPIKE register

<!-- F11: closes R4 P0 ch 14 — accepted-non-feature, not a spike. Coordination note for F6 (chapter 09 owner): please add to chapter 09 §6 a sentence "macOS hang detection (active liveness probe) is deferred to v0.4 hardening; v0.3 ships with launchd `KeepAlive=Crashed` only, which catches process exits but not hangs." -->

- **Status**: **DEFERRED to v0.4 hardening; not a v0.3 must-spike.** The original framing combined two mechanisms (launchd `KeepAlive=Crashed` + periodic in-daemon self-check) with a fallback of "live without watchdog on macOS in v0.3" — i.e. the spike outcome did not gate ship. v0.3 ships on macOS with launchd `KeepAlive=Crashed` only (catches process exits, not hangs). A hung daemon on macOS in v0.3 leaves the user in the "daemon unreachable" UX path (chapter [08](./08-electron-client-migration.md) §6 modal: "ccsm daemon is not running. Try restarting the service."). v0.4 hardening will introduce an active liveness probe (Supervisor `/healthz` poll + restart) — that work will get its own spike entry in the v0.4 register (see §4 below).
- **Cross-chapter**: chapter [09](./09-crash-collector.md) §6 documents the v0.3 macOS posture; chapter [13](./13-release-slicing.md) does NOT have a phase blocking on this spike anymore.

#### 1.16 [msi-tooling-pick] — WiX 4 vs electron-builder MSI builder
- **From**: [10](./10-build-package-installer.md) §5.1 (cross-ref F9 R5 P1-10-1).
- **Phase**: blocks phase 10 (Win installer); see [13](./13-release-slicing.md) §Phase 9.5.
- **Hypothesis**: WiX 4 (standalone, invoked from Node via `@wixtoolset/wix` or `wix.exe`) produces a smaller, more controllable MSI than `electron-builder`'s built-in MSI target for our daemon-only (non-Electron-bundled) install scenario; both can express `<ServiceInstall>` with custom SDDL.
- **Validation (repro recipe)**:
  1. Build the §1.10 sea hello-world; produce two MSIs from the same payload — one via `wix build installer.wxs` (with `<ServiceInstall>` + `<util:PermissionEx>`), one via `electron-builder --win msi` driven by a minimal `electron-builder.yml` that points at the sea binary.
  2. Install each on a fresh Win 11 25H2 26100.2314+ VM (clean snapshot per run); verify `Get-Service ccsm-daemon` shows `Running`; verify `(Get-Acl <binary>).Sddl` matches the expected SDDL.
  3. Compare: MSI size, install time, uninstall residue (file/registry diff via `tools/spike-harness/install-residue-diff.ps1`), ability to express custom SDDL on the binary directly (not via post-install `sc sdset`).
- **Kill-criterion**: WiX 4 build fails on CI runner OR cannot express the SDDL declaratively OR uninstall leaves residue beyond the documented allowlist; in that case the pick is `electron-builder`. If both fail (cannot express SDDL declaratively), fall back to MSI + post-install custom action via `sc.exe sdset` (covered in §1.14).
- **Fallback**: pick `electron-builder --win msi` and apply SDDL via the post-install custom action mechanism specified in §1.14.

### 1.A Per-OS transport decision matrix (filled after spikes 1.1–1.5 land)

The transport spikes (§1.1, §1.3, §1.4, §1.5) are independent in framing but compose into one shippable per-OS pick. After all four resolve, this table gets filled in (one row per OS) before phase 1 starts; reviewers cross-check that the row is filled and self-consistent.

| OS | Listener-A transport pick | Descriptor `transport` value | Installer steps required (delta vs default) | Provisioning owner |
| --- | --- | --- | --- | --- |
| Windows 11 25H2 (x64) | A4 (named pipe) if §1.5 passes, else A1 (UDS) if §1.1 passes, else A3 (h2 over TLS+ALPN on loopback TCP) if §1.3 fallback fires, else A2 (h2c loopback) — pin order **A4 → A1 → A2 → A3** per chapter [03](./03-listeners-and-transport.md) §4 | `pipe` / `uds` / `tcp+tls` / `tcp` (closed-set, locked by F2) | A3 only: WiX `<Component>` ships per-install self-signed cert + `installer-cert-gen.ps1` writes `%PROGRAMDATA%\ccsm\listener-a.crt`; Electron Connect transport's `tls` option pins fingerprint (NOT installed in OS root store) | Installer custom action |
| macOS 14+ (arm64 + x64) | A1 (UDS at SIP-safe path `/var/run/com.ccsm.daemon/daemon.sock`) if §1.4 passes, else A2 (h2c loopback) — A3 not used on macOS in v0.3 | `uds` / `tcp` | A1 only: pkg postinstall script `mkdir -p /var/run/com.ccsm.daemon` (recreated on boot via launchd `RuntimeDirectory` analog, see chapter [02](./02-process-topology.md) §2.2) | pkg postinstall |
| Linux (Ubuntu 22.04+ x64) | A1 (UDS at `/run/ccsm/daemon.sock`) if §1.4 passes, else A2 (h2c loopback) | `uds` / `tcp` | A1 only: systemd unit `RuntimeDirectory=ccsm` + `RuntimeDirectoryMode=0750` (covered by F5 chapter [07](./07-data-and-state.md)) | systemd unit (in deb/rpm) |

If a row's spike outcome forces A3 (TLS) on Windows, the descriptor schema additions are the cert path and the SHA256 fingerprint (additive `cert_path` + `cert_sha256` fields on the descriptor; the `transport=tcp+tls` value gates whether they are read). All values are part of the closed-set `transport` enum locked by F2; no new enum values are added later.

### 1.B Spike harness — `tools/spike-harness/`

All spike repro recipes above reference scripts under a single `tools/spike-harness/` directory pinned in this spec. The harness is a v0.3 build artifact (lives in the monorepo at `tools/spike-harness/`, NOT in `packages/`); its contents are forever-stable in the sense that v0.4 spikes can extend (additive scripts) but MUST NOT remove or change the contract of an existing script. Required contents:

- `wrap-as-localservice.ps1` — wraps any `.exe` as a Windows service running under `NT AUTHORITY\LocalService` with caller-supplied SDDL. Used by §1.1.
- `set-pipe-dacl.ps1` — applies an SDDL string to a named-pipe handle. Used by §1.1.
- `connect-and-peercred.js` — connects to a UDS or named pipe, prints the resolved peer SID/UID. Used by §1.1, §1.4, §1.5.
- `pty-emitter.js` — drives the W1–W6 workload classes from chapter [06](./06-pty-snapshot-delta.md) §8 through `node-pty`. Used by §1.7.
- `delta-collector.js` — daemon-side collector asserting `seq` contiguity + SHA-equal payload concatenation. Used by §1.7.
- `vt-grammar.js` — weighted CSI/OSC/DCS sequence generator. Used by §1.8.
- `snapshot-roundtrip.spec.ts` — property runner for the SnapshotV1 round-trip. Used by §1.8.
- `sea-hello/` — proto-free hello-world for the sea / notarization spikes. Used by §1.10, §1.13.
- `entitlements-jit.plist` — macOS hardened-runtime entitlements with JIT allowance. Used by §1.13.
- `install-residue-diff.ps1` — pre/post install file-tree + registry diff with allowlist. Used by §1.16 (and chapter [12](./12-testing-strategy.md) ship-gate (d)).
- `rtt-histogram.js` — HTTP/2 unary p50/p95/p99 RTT histogram (loopback or UDS). Used by §1.3, §1.4, §1.5.
- `stream-truncation-detector.js` — server-stream consumer that asserts no truncation under a configurable rate. Used by §1.3, §1.4, §1.5.

Cross-link: chapter [11](./11-monorepo-layout.md) §2 / §6 references `tools/spike-harness/` as a pinned source path; chapter [12](./12-testing-strategy.md) §3 reuses `install-residue-diff.ps1` for ship-gate (d).

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
