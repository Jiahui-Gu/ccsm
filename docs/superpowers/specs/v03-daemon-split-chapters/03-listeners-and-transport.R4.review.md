# 03 — Listeners and Transport — R4 (Testability + Ship-Gate Coverage)

## P0 — Transport fallback matrix: no test ensures all four shipping configurations work

§4 enumerates A1 (h2c-uds), A2 (h2c-loopback), A3 (h2-tls-loopback), A4 (h2-named-pipe). v0.3 ship will pick one or more per OS based on spike outcomes. Chapter 12 §3 has `connect-roundtrip.spec.ts` but doesn't say "parameterized over each shipping transport." The descriptor file's `transport` field is forever-stable and ranges over 4 values; the daemon's `makeListenerA` factory must support whichever was picked at install time AND the Electron transport factory must support it. If linux ships A1 and Windows ships A4, the integration tests must run for both (or each on its native OS).

Pin: integration tests parameterized by `transport` value matching what each OS ships. Add `tools/transport-matrix.json` enumerating per-OS choices that drives the test parameterization. Currently chapter 12 §3 just says "Daemon runs in-process on an ephemeral port / temp UDS path" — implies one transport per platform but doesn't enforce it matches the production pick.

P0 because the descriptor format is forever-stable and supports 4 transport kinds; integration tests pin only one per platform; a transport-pick change post-spike could ship untested code paths.

## P1 — Peer-cred middleware loopback-TCP path has unspecified race window

§5: "parse `/proc/net/tcp` (linux) or `GetExtendedTcpTable` (win) ... Rejection if mapping fails."

There is a race window: client connects, daemon `accept()` returns, daemon queries OS for "PID owning remote port X" — if the client process exited in that window, lookup fails and middleware rejects. Spec says "Electron handles by reconnecting" — but if the lookup races on every connect during heavy load, Electron loops forever. Add a test: spawn a client that connects then immediately exits; daemon should reject ONCE; subsequent live client connections should succeed. Also pin a max retry budget on the Electron side so the loop terminates.

P1 because the race is inherent to the loopback-TCP transport; if A2 ships (likely on win as A4 fallback), this is the production path.

## P1 — Listener B stub assertion `makeListenerB throws` is correctly tested but `// listeners[1] = makeListenerB(env)` comment-marker is not

§6: "The daemon startup code MUST contain the exact line `// listeners[1] = makeListenerB(env);  // v0.4` as a code comment."

Chapter 12 §2 has `listeners/listener-b.spec.ts` for the throw. There is no test asserting the comment exists in the source (preventing accidental deletion that would regress v0.4 reviewability). Add a tiny grep: `grep -F "// listeners[1] = makeListenerB(env);" packages/daemon/src/index.ts || exit 1`.

## P1 — Supervisor HTTP endpoints are forever-stable but lack contract tests

§7 lists `/healthz`, `/hello`, `/shutdown`. JSON shape pinned for `/healthz`. Chapter 12 has no `supervisor-contract.spec.ts` asserting:
- GET /healthz returns 200 + `{"ready":true,"version":"...","uptimeS":N}` shape
- POST /hello records caller PID
- POST /shutdown rejects non-admin

Important because chapter 04 §7 / chapter 15 §1 forbid changing these forever — but without a test pinning the wire shape, drift is possible.

## P1 — `version: 1` descriptor file has no schema validator + no test

§3: descriptor file `version: 1` is forever-stable. No JSON Schema, no validator, no test. Electron parses it; if daemon writes a malformed file, Electron crashes on parse. Add: ship a JSON schema in `packages/daemon/src/listeners/listener-a.schema.json`; daemon validates before writing; Electron validates before consuming; test asserts each writeable variant validates.

## P2 — `jwtBypassMarker` no-op middleware existence is asserted nowhere

§2: "explicit marker so audits see it." No test asserts the marker is in the chain. Add: assert `Listener.authChain[1].name === "jwtBypass"` in a startup test.

## Summary

P0: 1 / P1: 4 / P2: 1
Most-severe: **The descriptor's transport-kind field admits 4 production values but integration tests only run against one per platform; a post-spike transport-pick change ships untested.**
