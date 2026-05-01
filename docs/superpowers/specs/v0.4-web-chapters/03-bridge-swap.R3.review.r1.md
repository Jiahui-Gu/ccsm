# Review of chapter 03: Bridge swap

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P1-1 (must-fix): Reconnect storm guard insufficient — "max 6 attempts in 30s" leaves no fallback after exhaustion

**Where**: chapter 03 §3 ("Connection lifecycle" — reconnect retry).
**Issue**: Spec says "exponential backoff capped at 5s, max 6 attempts in 30s, then surface `daemon.unreachable`" but doesn't say what happens AFTER surfacing. Does the bridge retry on next user action? Auto-retry on a slower cadence (e.g. 60s)? Stop forever until reload? Web client (chapter 04 §6) explicitly does indefinite exp-backoff to 30s; Electron should match or the docs should explain why they diverge.
**Why this is P1**: "stuck unreachable" with no auto-retry means user has to know to click "Retry" or reload, but Electron has no such button surface today (chapter 04's banner is the web one). Failure mode = user thinks app is broken; restarts Electron. Reliability-wise this is "recovery requires user intervention when automated recovery is feasible."
**Suggested fix**: After the 6×30s burst, fall back to a 30s steady-state retry (same as web). Document the transition: "burst → steady" mode. Add an explicit `daemon.unreachable` banner with manual "Retry now" button to the Electron renderer if not already present (cross-ref chapter 04 §6 surface).

### P1-2 (must-fix): "Single shared HTTP/2 session for all calls" creates correlated-failure blast radius

**Where**: chapter 03 §3.
**Issue**: One HTTP/2 session multiplexes ALL bridge RPCs and ALL streams. If the underlying socket errors mid-flight (e.g. daemon process restart, OS pipe limit, antivirus interference), every in-flight RPC + every active stream rejects simultaneously. Spec acknowledges "in-flight RPCs reject with a `unavailable` Connect error; bridges surface this as `BridgeTimeoutError`" but doesn't specify whether queued retries deduplicate (related to chapter 02 P1-1 idempotency). Worse, if session re-establishes, all streams (~11 server-streams) re-subscribe at once → snapshot storm on the daemon.
**Why this is P1**: every reconnect under load triggers N parallel snapshot RPCs (chapter 06 §6: "force re-snapshot" if seq > buffer). Snapshot semaphore (v0.3 frag-3.5.1) serializes them but the queue depth = N streams. With M=20 sessions in user's box, that's 20 serialized snapshots blocking each other for seconds. User perceives "everything froze on reconnect."
**Suggested fix**: §3 add "Reconnect choreography" subsection: stagger stream re-subscribes with ±jitter (50-500ms) keyed off sessionId hash. Document expected wall-clock for full reconnect at N=20 sessions. Cross-ref chapter 06 §6 fanout buffer sizing.

### P1-3 (must-fix): Adapter parity test removal in M2 leaves no automated wire-level regression detector

**Where**: chapter 03 §7 (test discipline) + chapter 09 §3 M2.Z.
**Issue**: §7 says "parity tests deleted at M2." After M2, no automated test asserts that a bridge swap didn't subtly change behavior (e.g. a field was renamed in protobuf and the bridge adapter mapped it to the wrong renderer key). Contract tests (chapter 08 §3) verify the daemon serves the proto correctly, but the renderer/bridge adaptation layer (chapter 03 §4 "Adaptation lives in the bridge file") has no equivalent enduring check.
**Why this is P1**: future proto edits (renaming a field, adding/removing optionality) can silently break the adapter without any test catching it until manual e2e or user dogfood. This is the class of bug `buf breaking` doesn't catch (it catches WIRE compat; bridge adaptation is post-wire).
**Suggested fix**: Promote a subset of parity tests to "bridge adapter contract tests" — keep ~one-per-bridge-method assertion that the bridge function's return shape matches the renderer's expected v0.3 type. Survives M2. Document in §7 + chapter 08 §3.

### P2-1 (nice-to-have): No structured logging contract for bridge-side failures

**Where**: chapter 03 §3.
**Issue**: When bridge surfaces `BridgeTimeoutError`, there's no specified log line at the renderer/preload level. Diagnosing "user reports random freezes" requires correlating daemon trace-id with renderer console — but renderer doesn't log it.
**Suggested fix**: Bridge wraps Connect errors with `console.warn({ bridge, method, code, traceId })` so user-side console (or remote-error capture future state) can correlate.

### P2-2 (nice-to-have): "JWT bypass for local socket" tag on transport — what happens if tagging breaks?

**Where**: chapter 03 §3 + chapter 05 §4 (cross-ref).
**Issue**: The `localTransportKey` tag gates JWT bypass. If a future refactor accidentally drops the tag on local-socket requests, every Electron RPC fails `unauthenticated` because there's no JWT. There's no smoke test asserting "local socket request reaches handler with localTransportKey=true."
**Suggested fix**: Add a contract test (chapter 08 §3) "local-socket request bypasses JWT" + "remote-tagged request without JWT rejects." Already implicit in §3 mention but spec the test explicitly.

## Cross-file findings (if any)

- **Reconnect choreography (P1-2)** ties to chapter 06 §6 (re-snapshot semantics) and chapter 04 §6 (web reconnect cadence). Recommend single fixer for both files to keep numbers (jitter window, retry counts, steady-state cadence) consistent.
- **Idempotency (chapter 02 P1-1)** referenced here as a precondition for safe retry under chapter 03 §3 reconnect.
