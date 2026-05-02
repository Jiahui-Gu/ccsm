# R3 review — 08-electron-client-migration

## P1-R3-08-01 — Reconnect contract does not specify subscription-resume behavior

§6 states: "Stream errors (`Attach`, `WatchSessions`, `WatchCrashLog`) trigger automatic reattach with exponential backoff capped at 30s. Reattach uses the recorded last-applied seq for `Attach`."

R3 angle 14 (daemon restarts mid-session): is `WatchSessions` automatically re-subscribed on reconnect, or does it need to be re-issued by app code? The chapter implies "automatic reattach" but does not spell out:

- Does React Query's retry handle it, or does the rpc/queries.ts wrapper need a manual reconnect-and-resubscribe loop?
- For `WatchCrashLog`, is there a "since" parameter to avoid re-receiving entries the client already has? (Looking at chapter 04 §5 — `WatchCrashLogRequest` has no `since_unix_ms`. Reattach after reconnect would re-emit history? Or only new? Not specified.)

Recommend §6 explicitly state "on stream error, the wrapper re-issues the same RPC with the most recent state cursor (Attach: since_seq; WatchCrashLog: max(ts_ms) seen; WatchSessions: stateless re-subscribe is OK because it's event-only)". Without this, implementer guesses; UX inconsistencies between streams.

## P1-R3-08-02 — UNAVAILABLE banner UX for daemon-not-running case (R3 angle 13)

§6 covers `UNAVAILABLE` (daemon restarting) with a "Reconnecting..." banner. But R3 angle 13 — Electron launches when daemon is NOT running at all (service stopped, never started, broken install) — has no separate UX:

- Does Electron retry forever silently?
- Does it auto-launch the service (Windows: requires admin elevation)?
- Does it surface a "Daemon not running. Open service manager?" dialog after N retries?

Spec MUST pick: recommend "after 5 retries (≈ 30s of backoff), surface a modal explaining the daemon service status and offering an `Open Services` / `launchctl` command path". Currently the user sees a perpetual "Reconnecting..." with no actionable info — the worst possible failure UX.

## P2-R3-08-03 — Bridge in main process is a recommendation, not a decision (R3 reliability)

§4 MUST-SPIKE [renderer-h2-uds] fallback is "a tiny transport bridge in the main process". Chapter 14 §1.6 elevates this to "v0.3 SHOULD ship this bridge for predictability across all OSes." Chapter 15 §4 item 9 asks the reviewer to confirm.

R3 angle: a transport bridge in main is a NEW failure point (can crash, leak, hang) and a NEW thing to monitor. If shipped, it MUST appear in:
- Crash collector capture sources (chapter 09 §1 — "main_bridge_crash" or similar).
- Electron error contract (§6 — what happens when bridge is up but daemon is down? bridge surfaces UNAVAILABLE same as direct connection? specify).

Decide bridge yes/no in this spec; if yes, add the failure-mode handling. Currently undecided = downstream chapters can't be complete.

## NO FINDING — `lint:no-ipc` gate (§5h, §7)

Static + runtime gates are well-defined.

## NO FINDING — `additionalArguments` for descriptor (§4)

Reasonable; clean preload surface.
