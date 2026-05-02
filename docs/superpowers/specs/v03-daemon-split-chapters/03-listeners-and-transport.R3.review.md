# R3 review — 03-listeners-and-transport

## P1-R3-03-01 — No heartbeat / keepalive contract for non-PTY long-lived streams

§7 specifies the Supervisor surface but the chapter is silent on HTTP/2 keepalive for Listener A. PTY streams have an application-level `PtyHeartbeat` every 10s (chapter 04/06) — good. But `WatchSessions` (chapter 04 §3) and `WatchCrashLog` (chapter 04 §5) have NO heartbeat; they may sit idle for hours waiting for an event. R3 angle 12 ("when client disappears, daemon detects how soon?") is unanswered:

- HTTP/2 PING frames are not specified (Node `http2` defaults are unset; effective behavior depends on transport).
- TCP keepalive defaults differ across OSes (linux 7200s default, mac similar). A dead Electron behind a frozen renderer would not be detected for hours, holding a subscriber slot.

Add to §4: "Listener A enables HTTP/2 PING every 30s; idle PING-ack timeout 30s closes the stream; on UDS / named pipe the same applies. Underlying socket TCP keepalive is enabled with 30s probe interval."

## P1-R3-03-02 — Connection descriptor file lifecycle on crash / reboot is unspecified

§3 specifies the descriptor format and per-OS write path. It does NOT specify:

1. Whether the daemon overwrites or appends on every bind (overwrite is implied but not stated; an append bug would silently break Electron).
2. Whether stale descriptors are cleaned on uninstall (chapter 10 §5 does not list it either).
3. What Electron does when the descriptor file exists but the address is not listening (e.g., daemon crashed before unlinking; reboot where listener-a.json from previous-OS-image exists). Spec says "Electron retries with backoff" elsewhere but the descriptor itself is treated as authoritative.
4. On Linux the path is `/run/ccsm/listener-a.json` — `/run` is a tmpfs, auto-cleaned on reboot. Good. But mac (`/Library/Application Support/`) and win (`%LOCALAPPDATA%`) PERSIST across reboots — stale descriptor from previous boot is the default state for ~1 second after boot, before daemon rewrites.

Add: "Daemon truncates+rewrites descriptor atomically (write to `<path>.tmp`, fsync, rename) on every successful Listener A bind. Daemon unlinks descriptor on graceful shutdown. Electron tolerates a non-connectable descriptor by retrying — descriptor presence is not a sufficient condition for daemon liveness."

## P1-R3-03-03 — No Healthz RPC; only HTTP /healthz

§7 ships `/healthz` as an HTTP endpoint on Supervisor UDS. R3 angle 21 wants a Connect-RPC `Healthz` on Listener A so the installer can verify the data-plane (not just supervisor), and so a future `curl --connect-to` debug works against the same surface clients use. Recommend adding a `HealthService.Check()` RPC in chapter 04 — currently the only way Electron knows daemon is healthy is by trying any RPC; a dedicated Health RPC is the standard pattern (gRPC health checking protocol) and zero-cost.

Currently the installer uses `/healthz` on Supervisor — adequate for ship-gate (d). But the data plane has no equivalent: a healthy supervisor does not prove Listener A bound (it returns 200 once "startup step 5 completes" per §7, which does cover Listener A bind, so this is technically OK). Downgrading from P0 to P1 because supervisor /healthz is acceptable — but flag for spec author to consider Healthz on data plane for future v0.4 web client (which cannot reach Supervisor UDS).

## P1-R3-03-04 — Peer-cred resolution failure mode under load

§5 says "If peer-cred resolution fails (e.g., process exited between accept and lookup on loopback TCP), the middleware throws `Unauthenticated`. Electron handles by reconnecting." Two sub-issues:

1. On Loopback TCP (the Win fallback path), the race window between `accept()` and `GetExtendedTcpTable()` lookup is non-zero — a transient burst of connection churn (e.g., Electron rapid-reconnecting after daemon restart) could cause spurious `Unauthenticated` errors. Spec should cap retries on Electron side (chapter 08 §6 says backoff cap 30s; should also cap retry count and surface persistent failure as a different error class).
2. Peer-cred lookup itself can fail with EBUSY / transient OS errors. Spec does not distinguish "permanent identity mismatch" from "transient lookup failure" — both throw `Unauthenticated`. Reviewer recommends a separate `Unavailable` error code for transient lookup failures so Electron retries vs surfacing.

## P2-R3-03-05 — Supervisor UDS bind failure path

§7 introduces Supervisor UDS but does not specify what happens when its bind fails (port/path collision after unclean shutdown). The startup order in chapter 02 §3 puts Supervisor at step 3 (before Listener A at step 5), so a Supervisor bind failure aborts boot entirely. Add a sentence that Supervisor is also subject to the same stale-path cleanup as Listener A (per R3-02-05).

## NO FINDING — listener trait fixed-array shape (§1)

The justification for fixed array vs Map (review-time auditability) reads correctly from the R3 angle.
