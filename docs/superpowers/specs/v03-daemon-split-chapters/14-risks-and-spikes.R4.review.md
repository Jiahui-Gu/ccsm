# 14 — Risks and Spikes — R4 (Testability + Ship-Gate Coverage)

Angle: every MUST-SPIKE must have (a) a repro recipe and (b) a kill criterion. R4 audited all 15 entries.

## P0 — Two spike kill-criteria are vague enough to be unfalsifiable

### 1.6 [renderer-h2-uds]
> Kill-criterion: Chromium fetch cannot use UDS / named pipe (this is true today for stock fetch; Connect-node provides a `node:http2` based transport that requires main-process construction OR a polyfill).

This is a **statement of current fact**, not a kill criterion. The spike then says "Fallback: ... v0.3 SHOULD ship this bridge for predictability across all OSes." Translation: we already know the kill condition is met → we will ship the fallback by default. So **this is not a spike, it is an accepted fallback**. Two consequences:
1. The spec should move the bridge from "fallback" to "default" in chapter 08 §4 and pin the bridge implementation requirements (port choice, descriptor file, lifecycle). Currently chapter 08 §4 talks about Connect-RPC directly from renderer with the bridge as an unfortunate fallback.
2. If we ARE shipping the bridge by default, the actual spike is "does the bridge correctly proxy unary + server-stream + bidi?" That is the test that should be specified, not "can renderer fetch a UDS."

P0 because the testing strategy chapter (12 §3) tests the wire from "renderer Connect client" to daemon over Listener A — but if the bridge is the actual transport in production, every integration test must run **through the bridge**, not against the daemon directly. Otherwise integration tests pass while the production hot path (renderer → bridge → daemon) is untested.

### 1.15 [watchdog-darwin-approach]
> Hypothesis: launchd `KeepAlive=Crashed` plus periodic in-daemon self-check is sufficient liveness for macOS.
> Kill-criterion: launchd does not restart.
> Fallback: live without watchdog on macOS in v0.3; document as v0.4 hardening; do NOT block ship.

The hypothesis combines two things ("KeepAlive=Crashed" and "periodic in-daemon self-check"). The kill criterion only addresses the first ("launchd does not restart" — restart from what? a crash? a hang? `KeepAlive=Crashed` only fires on actual crash, not hang). The fallback says "live without" — but that means the spike outcome doesn't matter; we ship without watchdog regardless. This is an **accepted non-feature**, not a spike. Either:
- Mark it explicitly as "deferred to v0.4; not a v0.3 must-spike" and remove from the register, OR
- Define the actual hang-detection mechanism v0.3 ships on macOS (e.g., service manager polls `/healthz` every 60s; if 503 for 3 consecutive polls, restart) and spike THAT.

P0 because either the spike is a no-op (waste of a register slot) or the v0.3 macOS daemon ships with no hang detection — which means a hung daemon on macOS leaves the user with no sessions and no recovery. The brief crash collector chapter (§9) doesn't say what the user sees in that case.

## P1 — Several spike repro recipes are insufficient for someone else to execute

### 1.1 [win-localservice-uds]
"Validation: Win 11 25H2 VM, install service, run Electron from a non-admin user, attempt connect; verify peer-cred returns the interactive user's SID."
Missing: WHICH 25H2 build (25H2 has multiple build numbers; firewall behavior differed in early builds). HOW to install the service before the installer exists (manual `sc create` with what arguments? Daemon binary doesn't exist yet at spike time.) WHAT exact DACL string. The spike must be a recipe a contractor could execute solo.

### 1.7 [worker-thread-pty-throughput]
"Validation: synthetic emitter writes 50 MB of mixed VT in 30s." `mixed VT` = which sequences? ASCII text? Heavy SGR? Alt-screen? The encoder/decoder hotpath behaves wildly differently per workload. Reuse the chapter 06 §8 workload class enumeration here.

### 1.8 [snapshot-roundtrip-fidelity]
"property-based test with 1000 random VT byte sequences" — random over what alphabet? Random uint8s will be ~0% useful (almost all sequences will be ESC + garbage that resets to literal bytes). Need a generator that produces probabilistically-valid VT (use `xterm.js`'s own fixture corpus, or hand-crafted grammars). Without that, "1000 random sequences" is a coverage-theatre claim.

### 1.10 [sea-on-22-three-os]
"Validation: build minimal hello-world daemon binding Listener A, running Hello, exiting cleanly." The Listener A code includes peer-cred middleware which depends on `node-pty`-adjacent native modules NOT — peer-cred is direct syscalls. But "running Hello" requires Connect server + proto stubs from chapter 04. Spike output predates phase 1 (proto). Recipe needs "OR a stripped version: bind a TCP listen, accept one connection, write 'OK', exit."

### 1.13 [macos-notarization-sea]
"Validation: notarize a hello-world sea; check stapler." Notarization needs an Apple Developer ID; spec doesn't say who provisions the cert before phase 10. If notarization spike fires in phase 0 (it should — it gates phase 10), the cert must exist by phase 0 — that is an ops dependency. Pin the prereq.

P1 because spikes that aren't reproducible block themselves; the engineer assigned to spike X can't be sure they're testing what the spec author intended.

## P1 — Two spikes have "escalate to user before adopting" fallbacks that aren't real fallbacks

1.7 [worker-thread-pty-throughput] and 1.8 [snapshot-roundtrip-fidelity] both end with "Escalate before adopting."

That is not a fallback — it's a punt. If the spike kills, ship is blocked until the user makes a decision. The spec should pre-stage the decision: list the specific design rework that would be required (e.g., for 1.7: "switch to per-session child_process; lose xterm-headless server-side state machine; ship-gate (c) becomes 'best-effort byte replay'; user accepts dogfood quality drop"). That's a real fallback even if it requires user signoff. Currently the fallback bullet leaves a hole.

## P1 — `listener-a` transport spike outcomes don't enumerate a decision matrix per OS

§1.3, §1.4, §1.5 are all transport spikes (Win 25H2 h2c-loopback, Unix UDS h2c, Win named pipe h2). Each has hypothesis + kill + fallback in isolation. There is no chapter section that says "if Win h2c-loopback kills AND named pipe kills, fall back to A3 TLS — and here is how the descriptor changes — and here is who runs the cert generator at install time." The fallback chains are independent in the prose; in reality they interact (A3 TLS adds a cert provisioning step in the installer that doesn't exist anywhere in chapter 10). Add a table or decision-tree at end of §1: "after spikes complete, the per-OS transport pick is X; the descriptor schema additions required are Y; the installer steps required are Z." Without it, spike outcomes don't compose into shippable design.

## P1 — Ship-gate testability of spikes themselves

Several spikes' kill criteria (e.g., 1.3 "p99 RTT > 50 ms loopback OR stream truncation") demand a benchmark + observability harness. There is no listed "spike harness" reusable across spikes. The team will write one-off scripts; one-off scripts don't get tested; one false-pass means a kill criterion missed. Pin a `tools/spike-harness/` directory with the reusable bits (an HTTP/2 RTT histogram, a stream-truncation detector, a peer-cred resolver wrapper). Reuse across spikes 1.3, 1.4, 1.5.

## P2 — Residual-risks table is good but missing one

§2 lists 6 residual risks. Missing: **`worker_threads` Workers in a SEA bundle**. SEA + Worker has an open Node issue history around resolving the worker entry-point inside a single binary. Chapter 06 §1 mandates worker_threads. There is no spike for "worker_threads inside Node 22 SEA on win/mac/linux." This intersects spike 1.10 and 1.7 but is neither. Add as 1.16.

## Summary

P0 count: 2 ([renderer-h2-uds] is an accepted fallback not a spike; [watchdog-darwin] is a no-op/accepted-non-feature)
P1 count: 4
P2 count: 1

Most-severe one-liner: **The "renderer over UDS" spike is already known-fail; the actual production transport (main-process bridge) is hidden in the fallback bullet and never validated by integration tests.**
