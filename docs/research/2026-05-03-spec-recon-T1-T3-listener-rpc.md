# v0.3 Spec Reconciliation — Sub-audit B (T1.x listener + T2.x/T3.x RPC/session)

**Date**: 2026-05-03
**Author**: research agent (pool-11, Task #204)
**Scope**: Deep dive on T1.x daemon listener subsystem + T2.x/T3.x RPC/session/principal vs. `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` chapters 03 (Listeners + Transport), 04 (Proto/RPC), 05 (Session/Principal).
**Companion**: baseline audit `docs/research/2026-05-03-v03-spec-reconciliation-audit.md` on `research/2026-05-03-spec-reconciliation`.
**Mode**: READ-ONLY. No production code changes. No PR.

This sub-audit re-walks every T1.x / T2.x / T3.x file at line granularity and surfaces drifts the merged-PR-row baseline audit either could not see (because it was a one-row-per-PR pass) or treated as benign. New CRITICAL items are in §A; refinements / corrections to the baseline rows are in §B; the previously identified drifts that survive deep re-read with no change are confirmed in §C.

---

## Severity legend (same as baseline)

- **ALIGNED** — implementation completely matches spec.
- **MINOR DRIFT** — naming / path / decoration; no behavior delta.
- **DRIFT** — real behavior or design difference; ship-acceptable but a divergence.
- **CRITICAL DRIFT** — violates a spec invariant or ship-gate; should not ship as-is.

---

## §A — New findings (not in the baseline audit)

### A1. **CRITICAL DRIFT** — Production daemon binds Listener A WITHOUT peer-cred / auth interceptor wired

**Spec ref**: ch03 §1 ("authChain is composed in order; produces ctx.principal"), ch05 §2 ("daemon does NOT have a 'no principal' code path. Every RPC handler reads `ctx.principal` and assumes it is set. If middleware did not set it, the daemon throws `Unauthenticated` before reaching any handler. **This invariant is the security baseline.**").

**Evidence**:
- `packages/daemon/src/index.ts:174` — production wiring is literally: `listenerA = makeListenerA(env, { bindHook: makeRouterBindHook() });`. `makeRouterBindHook()` is called with **no arguments** → `routerOptions = {}`.
- `packages/daemon/src/rpc/bind.ts:68-86` — `makeRouterBindHook(routerOptions)` constructs the http2 server via `createDaemonNodeAdapter(routerOptions)` and binds via `bindByKind(...)`. The bind adapters (`bindH2cUds`, `bindH2NamedPipe`, `bindH2cLoopback`) simply call `server.listen(...)`. **None of them install a `'connection'` listener that calls `extractUdsPeerCred` / `extractNamedPipePeerCred` / `extractLoopbackTcpPeer` and writes the result into `contextValues[PEER_INFO_KEY]`.**
- `packages/daemon/src/rpc/router.ts:271-274` — `createDaemonNodeAdapter` only prepends `requestMetaInterceptor` to caller-supplied interceptors. `peerCredAuthInterceptor` is exported from `auth/index.ts` but is NEVER imported anywhere outside its own test file (`grep -rn "peerCredAuthInterceptor" packages/daemon/src/ | grep -v __tests__` returns only doc-comments and the export site itself).
- `packages/daemon/src/auth/peer-info.ts:97-102` — `NO_PEER_INFO` sentinel is the default; per `interceptor.ts:169-179`, observing this sentinel throws `Unauthenticated`. But the interceptor is never registered, so the sentinel is never even read.
- `packages/daemon/src/rpc/hello.ts:286-299` — handler reads `PRINCIPAL_KEY` and throws `Code.Internal` ("daemon wiring bug") if it is null. In production, since neither the auth interceptor nor the Hello handler itself is wired (see A2), this branch is unreachable: every Connect call in production currently terminates at the empty-stub `Unimplemented` response from `registerStubServices` BEFORE any auth concern arises.

**Impact**: 
1. The full v0.3 production daemon, started via `pnpm --filter @ccsm/daemon start`, exposes the Connect RPC surface as **stubs only** with **no authentication chain whatsoever**. The `peerCredAuthInterceptor`, `extractUdsPeerCred`, and `extractNamedPipePeerCred` modules ship dead in production.
2. Spec ch05 §2 invariant ("no 'no principal' code path") is violated structurally — the production handler graph contains zero principal-emitting code.
3. Spec ch03 §1 `authChain` requirement is met only for unit tests (which inject `peerCredAuthInterceptor` into a custom router options).
4. This is the ROOT explanation for why the baseline audit's #22/#26/#28/T1.4 rows all read "ALIGNED" individually — each module is internally correct, but the production composition omits them.

**Already fixed?**: **No.** This is an integration gap. None of the merged T1.x / T2.x PRs land the wiring that connects the accept event to `extractUdsPeerCred` and writes `PEER_INFO_KEY`. The spike harness probes show the *shape* of the wiring (`tools/spike-harness/probes/uds-h2c/server.mjs`), but it has not been ported to the daemon.

**Required fix touch points** (estimate, not prescription):
- A new module under `packages/daemon/src/transport/` that owns `'connection'` event handling per kind, runs the per-OS extractor, and stashes the `PeerInfo` so the connectNodeAdapter request handler can publish it to `contextValues[PEER_INFO_KEY]`. Connect-ES exposes a `contextValues` factory on the adapter options for exactly this.
- `index.ts` must pass `helloDeps`, `watchSessionsDeps`, and the `peerCredAuthInterceptor` (plus the OS-specific `udsLookup` / `namedPipeLookup` callbacks) into `makeRouterBindHook(...)`.
- A native addon (or Node 22 `dgram`-style hack) that implements `getsockopt(SO_PEERCRED)` / `LOCAL_PEERCRED` / `ImpersonateNamedPipeClient` is needed for the addon callbacks; the existing `auth/peer-cred.ts` ships only `unsupportedUdsLookup` / `unsupportedNamedPipeLookup` placeholders that throw.

---

### A2. **CRITICAL DRIFT** — Production daemon does NOT register the real Hello / WatchSessions handlers

**Spec ref**: ch04 §3 (Hello is forever-stable, mandatory on every connect), ch02 §3 step 5 ("Hello will succeed iff the descriptor Electron just read describes the daemon currently listening").

**Evidence**:
- `packages/daemon/src/index.ts:174` — `makeRouterBindHook()` is called with NO arguments. Inside `bind.ts:71`, that becomes `createDaemonNodeAdapter({})` with `helloDeps === undefined` and `watchSessionsDeps === undefined`.
- `packages/daemon/src/rpc/router.ts:269-270` — when `helloDeps === undefined`, the routes callback is `stubRoutes` (every service registered with empty `{}`, so every method including `Hello` returns `Code.Unimplemented`).
- `registerHelloHandler` and `registerSessionService` are exported (`router.ts:142, 169`) but are **never called** outside test files.
- `SessionManager` (`sessions/SessionManager.ts:238`) is exported as a class but is **never instantiated** in `index.ts` — the class lacks any production constructor call. `runStartup()` returns `{ env, listenerA, db, crashPruner }` — no manager.

**Impact**:
1. Electron's spec-mandated `Hello` handshake (ch03 §3.3 step 3 — "immediately call `Hello` before any other RPC") will receive `ConnectError(Code.Unimplemented)` from a v0.3 daemon. Electron's reconnect logic interprets this as protocol incompatibility and surfaces "Daemon not running" — even though the daemon IS running.
2. `WatchSessions` cannot stream — the Connect router returns `Unimplemented` and Electron's per-stream backoff will reconnect indefinitely.
3. Ship-gate (b) "PTY zero-loss reconnect" requires session attachment, which presumes a running session; the create-session path is also unimplemented (T3.x is partially merged; see A3).
4. The integration test at `packages/daemon/src/auth/__tests__/integration.spec.ts` and the listener `__tests__` files inject `peerCredAuthInterceptor` + Hello handler manually, so unit-test green is NOT an indicator of production correctness.

**Already fixed?**: **No.** Neither T1.7 (which would naturally own this wiring per its scope) nor any later task has wired the Hello / WatchSessions handlers into `index.ts`'s `runStartup()`.

**Coupling with A1**: A1 and A2 are the same gap viewed from two angles — the *whole* T1→T2→T3 production handler graph is unwired. A single `index.ts` PR plus a native-addon PR closes both.

---

### A3. **CRITICAL DRIFT** — Listener-A descriptor file is NEVER written by the production daemon

**Spec ref**: ch03 §3 ("Daemon writes a JSON file at a known per-OS path on every successful Listener A bind"), ch03 §3.1 (atomic write discipline), ch02 §3 step 5 ("descriptor write is part of phase STARTING_LISTENERS").

**Evidence**:
- `packages/daemon/src/index.ts:169` — explicit comment `TODO(T1.6): write listener-a.json descriptor after bind succeeds.`
- `packages/daemon/src/listeners/descriptor.ts:103` — `writeDescriptor` is exported, fully tested, and ALIGNED to the spec atomic-write sequence (tmp + fsync + rename, with `wx` flag refusing stale tmp). But `grep -rn "writeDescriptor" packages/daemon/src/ | grep -v __tests__ | grep -v descriptor.ts` returns zero hits.
- `index.ts:177` writes `[ccsm-daemon] listener-a bound: kind=...` to stdout but never persists the descriptor.

**Impact**:
1. Electron's ch03 §3.3 step 1 ("Read `listener-a.json` from the locked per-OS path") fails because the file does not exist. Electron surfaces "Daemon not running" forever.
2. The `boot_id` rendezvous mechanism (ch03 §3.4) is structurally bypassed — no descriptor means no `boot_id` witness, so foreign-process collision detection fails open.
3. Ship-gate (a) "process split + Electron talks to daemon over Connect" cannot pass because Electron cannot find the daemon address.

**Already fixed?**: **No.** PR #863 shipped the *writer* module; no PR has wired it into the boot sequence.

**Required fix**: One-line addition in `runStartup()` after `listenerA.start()` succeeds: build a `DescriptorV1` from `env.bootId`, `env.version`, the resolved `listenerA.descriptor()`, and `env.paths.supervisorAddr`, then `await writeDescriptor(env.paths.descriptorPath, payload)`. The descriptor's `transport` enum must be the spec-vocabulary `KIND_*` value, which means a translation step from `BindDescriptor.kind` (camelCase) — see B1 below.

---

### A4. **CRITICAL DRIFT** — Supervisor server (T1.7) is never instantiated in production

**Spec ref**: ch03 §7 (Supervisor UDS, three endpoints), ch02 §3 step 5 ("descriptor written before /healthz returns 200").

**Evidence**:
- `packages/daemon/src/index.ts:182` — explicit comment `TODO(T1.7): flip Supervisor /healthz to 200`.
- `packages/daemon/src/supervisor/server.ts` exports `makeSupervisorServer(...)` but `grep -rn "makeSupervisorServer" packages/daemon/src/ | grep -v __tests__` returns ZERO production callers.
- `runStartup()` reaches `Phase.READY` purely by lifecycle bookkeeping; nothing publishes that readiness over the spec's `/healthz` endpoint.

**Impact**:
1. The installer's post-register verification (`POST /hello`) cannot succeed → installer ships broken end-to-end.
2. The uninstaller's `POST /shutdown` flow is unreachable → graceful shutdown over the supervisor channel is impossible.
3. `/healthz` is the canonical "is the daemon ready?" probe for both Electron's daemon-cold-start modal (T6.8) and the OS supervisor (systemd / launchd / Windows SCM); without it, there is no first-class readiness signal.

**Already fixed?**: **No.** PR #914 shipped the supervisor module; no PR wired it.

---

### A5. **CRITICAL DRIFT** — `BindDescriptor.kind` enum vocabulary split is wider than the baseline noted

**Spec ref**: ch03 §1a closed-enum table; ch15 §3 forbidden-pattern 8 ("descriptor `transport` field MUST share one vocabulary with `BindDescriptor.kind`").

**Baseline audit row** (#24 T1.4): flagged the camelCase-vs-spec split at the type level.

**This audit's new evidence**:
- The `descriptor()` method on the `Listener` trait (`listeners/types.ts:60`) returns `BindDescriptor` (camelCase: `'uds' | 'namedPipe' | 'loopbackTcp' | 'tls'`).
- `listeners/descriptor.ts:33-37` declares `DescriptorTransport` as the SPEC vocabulary (`'KIND_UDS' | 'KIND_NAMED_PIPE' | 'KIND_TCP_LOOPBACK_H2C' | 'KIND_TCP_LOOPBACK_H2_TLS'`).
- `rpc/bind.ts:145-163` (`resolveDescriptor`) maps the *post-bind* `BoundAddress` from the transport layer back to the camelCase `BindDescriptor` shape — a SECOND translation hop using a THIRD vocabulary (`transport/types.ts:71-82` `BoundAddress.kind: 'uds' | 'namedPipe' | 'loopback' | 'tls'`, and note `'loopback'` not `'loopbackTcp'`).
- The descriptor-writer caller (which does not yet exist in production per A3) would need to translate `BindDescriptor.kind` → `DescriptorTransport`. NO such translator exists in the repo. Adding one would require a `Record<...>` table that has to be kept in sync manually.

**Three vocabularies, no central translator**:
| Layer | Vocabulary | File |
| --- | --- | --- |
| `Listener.descriptor()` return | `'uds' / 'namedPipe' / 'loopbackTcp' / 'tls'` | `listeners/types.ts` |
| Transport adapter `BoundAddress` | `'uds' / 'namedPipe' / 'loopback' / 'tls'` (note `'loopback'` not `'loopbackTcp'`) | `transport/types.ts` |
| Wire-stable `listener-a.json` `transport` | `'KIND_UDS' / 'KIND_NAMED_PIPE' / 'KIND_TCP_LOOPBACK_H2C' / 'KIND_TCP_LOOPBACK_H2_TLS'` | `listeners/descriptor.ts` |

The spec ch03 §1a explicitly says "`BindDescriptor.kind` is a closed enum stringified IDENTICALLY in `listener-a.json.transport`". The current code violates "stringified identically" with two intermediate layers.

**Impact** (over and above the baseline row):
- The T1.6 descriptor writer was implemented in isolation and uses the spec vocabulary directly (good); but when A3 is fixed and the writer is finally called from the boot path, the call site MUST contain a translation table that the spec says shouldn't exist.
- The forbidden-pattern 8 violation is structural, not just naming: `BindDescriptor` cannot be stringified into `listener-a.json` without a code change.

**Already fixed?**: **No.**

**Severity escalation rationale vs. baseline #24**: the baseline marked this CRITICAL DRIFT for the type-level split alone; this audit confirms a second wholly-separate vocabulary in `BoundAddress` (the third layer), making the violation triple-layered. Fix scope is bigger than baseline #24 suggests: 3 files (listeners/types.ts, transport/types.ts, plus a translator) need to converge.

---

### A6. **DRIFT** — Loopback TCP authentication is structurally test-only; production fallback path is incomplete

**Spec ref**: ch03 §5 loopback-TCP row ("parse `/proc/net/tcp{,6}` (linux) or `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL)` (win) or `lsof -i` equivalent (mac) to map remote port → owning PID → owning uid/SID. **Rejection if mapping fails.**").

**Evidence**:
- `auth/peer-cred.ts:141-164` — `extractLoopbackTcpPeer` parses the `Authorization: Bearer <token>` header. There is NO PID-based synthesis path.
- `auth/interceptor.ts:116-130` — the `loopbackTcp` branch of `derivePrincipal` accepts EXACTLY the hardcoded `TEST_BEARER_TOKEN === 'test-token'` (constant declared at `interceptor.ts:53`) and produces a fixed `local-user:test` principal. Any other token / missing token → `Unauthenticated`.
- Spec ch03 §4 transport pick A2 explicitly lists loopback h2c as a production fallback ("Default for win if named-pipe path fails the spike"). The MUST-SPIKE [loopback-h2c-on-25h2] outcome is recorded under `tools/spike-harness/probes/loopback-h2c-on-25h2/RESULT.md` as PASSED, so loopback could in principle be picked on Windows.

**Impact**:
1. If `CCSM_LISTENER_A_FORCE_LOOPBACK=1` is set in production (e.g., dev container, CI, edge case where the Windows named-pipe path regresses), the daemon is reachable only by callers that supply a `Bearer test-token` header. Electron does not supply this header → 100% Unauthenticated.
2. The spec's "PID lookup → uid/SID, Rejection if mapping fails" rule is unimplemented; the bearer-token shape is a v0.3 dev-only conveniences that ALSO makes production loopback unsafe (anyone on the same host who knows the literal string `test-token` can spoof a principal).
3. This is salvaged by the fact that production never runs loopback (per `transport-pick.ts:65-67`, the env var must be explicitly set), but the spike outcome shipping the fallback as production-ready and the spec's PID-synthesis requirement together suggest A6 needs a fix before any real shipped channel can be loopback.

**Already fixed?**: **No.** Reasonable to defer to v0.3.x or v0.4 if the named-pipe / UDS production paths are confirmed solid; flagging because the spec's "rejection if mapping fails" wording is a hard MUST.

---

### A7. **DRIFT** — RequestMeta validation interceptor relies on duck-type detection; spec mandates a structurally exhaustive check

**Spec ref**: ch04 §7.1 "request-meta-validation.spec.ts" — "asserts every Connect RPC rejects empty `RequestMeta.request_id` with `INVALID_ARGUMENT` + `ErrorDetail.code = 'request.missing_id'`; daemon does not silently synthesize."

**Evidence**:
- `rpc/middleware/request-meta.ts:125-144` — `extractMeta` first probes `meta.$typeName === RequestMetaSchema.typeName` (the strict identity check), then falls back to a duck-type `typeof meta.requestId === 'string'`. The DUCK-TYPE FALLBACK means a request whose `meta` field is, say, the wrong proto type but happens to have a string `requestId` field WILL be accepted as valid meta.
- The duck-type fallback is documented as "tolerate plain-object meta shapes (test harness convenience)" but is exposed at the production interceptor — there is no production / test fork.

**Impact**:
1. A misbehaving client that sends `{ meta: { requestId: 'x', wrongTypeMarker: ... } }` will pass validation. Probably benign in practice (proto serialization would reject the off-shape upstream), but the surface area is wider than the spec's "RequestMeta.request_id" rule implies.
2. The contract test at `packages/proto/test/contract/request-id-roundtrip.spec.ts` covers the happy-path/empty-id reject case, but does NOT cover "wrong-shape meta with string requestId" — so this drift is not currently caught by CI.

**Already fixed?**: **No.** Low-priority — the spec language is tight ("non-empty"), and the duck-type fallback satisfies it for any reasonable producer. Recommend renaming the interceptor's documented behavior to "duck-type tolerant" or removing the fallback once the test harness no longer needs it.

---

### A8. **MINOR DRIFT** — Spec test filenames diverge from the spec text

**Spec ref**: ch04 §7.1 names four contract tests verbatim:
- `proto/proto-min-version-truth-table.spec.ts`
- `proto/request-meta-validation.spec.ts`
- `proto/error-detail-roundtrip.spec.ts`
- `proto/open-string-tolerance.spec.ts`

**Evidence**: 
- `packages/proto/test/contract/error-detail-roundtrip.spec.ts` ✓ matches
- `packages/proto/test/contract/open-string-tolerance.spec.ts` ✓ matches
- `packages/proto/test/contract/version-negotiation.spec.ts` — spec says `proto-min-version-truth-table.spec.ts`
- `packages/proto/test/contract/request-id-roundtrip.spec.ts` — spec says `request-meta-validation.spec.ts`

**Impact**: Reviewers grepping for the spec-named files find nothing; no behavioral drift. Could be reconciled by renaming files OR by updating the spec text in a single sweep.

**Already fixed?**: **No.**

---

### A9. **DRIFT** — `Listener` trait uses open `id: string` instead of spec's `'A' | 'B'` literal union

**Spec ref**: ch03 §1 (`readonly id: "A" | "B"`).

**Evidence**:
- `listeners/types.ts:55` declares `readonly id: string;` — open string.
- `listeners/factory.ts:48` defines `LISTENER_A_ID = 'listener-a' as const` — note the value is `'listener-a'`, NOT spec's `'A'`.
- `rpc/hello.ts:102` defines a SECOND constant `LISTENER_A_HELLO_ID = 'A' as const`, which is what gets surfaced on `HelloResponse.listener_id`.
- Two non-overlapping constants for "which listener am I": `'listener-a'` for internal logs / descriptor file (would-be writer at A3), and `'A'` for the wire response.

**Impact**:
1. Spec's compile-time invariant ("the listener id is `'A' | 'B'`") is unenforced — TypeScript accepts any string for `Listener.id`.
2. Two-constant split is doc-only; a future writer might use `LISTENER_A_ID` ('listener-a') in HelloResponse by mistake, breaking the wire-stable expectation that clients see `'A'`.
3. Baseline audit's "T1.2 — Listener trait shape" row noted `id: string` open-typing as a DRIFT; this audit refines: the open-typing also enabled the silent constant split.

**Already fixed?**: **No.**

---

### A10. **DRIFT** — `peerCredAuthInterceptor` order vs. `requestMetaInterceptor` is documented as "spec does not pin"; spec actually IS implicit

**Spec ref**: ch04 §2 F7 ("Daemon MUST NOT silently synthesize a substitute"); ch05 §2 invariant ("there is no 'no principal' code path").

**Evidence**:
- `rpc/middleware/request-meta.ts:209` says: "**The spec does not pin a strict ordering between the two**, but the chosen wiring (auth first, then meta-validation) means an unauthenticated caller sees `Unauthenticated` rather than `InvalidArgument` — matching the 'auth is the outer ring' convention."
- `rpc/router.ts:271-274` actually wires it the OPPOSITE WAY: `requestMetaInterceptor` is prepended, `callerInterceptors` (including `peerCredAuthInterceptor` if the caller passed it) come AFTER. So in production: meta runs FIRST, auth runs SECOND.
- The router.ts comment at line 256-263 confirms: "T2.4 (#37) — `requestMetaInterceptor` is prepended to whatever interceptor list the caller supplies, so it runs FIRST in the chain."
- Spec ch05 §2 says principal is "the security baseline" → auth should be the outer ring → auth FIRST. The code does meta FIRST.

**Impact**:
1. An unauthenticated caller that omits `request_id` sees `InvalidArgument` (meta interceptor fired before auth) when spec convention says they should see `Unauthenticated`. This information leak is mild (client learns "the daemon's auth wasn't checked yet" — i.e., meta validation happens before auth) but inverts the normal "auth outermost" cake.
2. Two layers of comments contradict each other: middleware's own comment says "auth first then meta" (the desired wiring) but router.ts code does meta first.

**Already fixed?**: **No.**

---

### A11. **MINOR DRIFT** — `descriptor.ts` field-naming mixes camelCase and snake_case

**Spec ref**: ch03 §3.2 schema — JSON keys are snake_case (`boot_id`, `daemon_pid`, `listener_addr`, `protocol_version`, `bind_unix_ms`).

**Evidence**:
- `listeners/descriptor.ts:63-74` — `DescriptorV1` interface uses `tlsCertFingerprintSha256` (camelCase) and `supervisorAddress` (camelCase), but `boot_id`, `daemon_pid`, `listener_addr`, `protocol_version`, `bind_unix_ms` (snake_case).
- The spec schema example (lines 351-364 of the spec) uses ONLY snake_case for every field that matters.
- `tlsCertFingerprintSha256` and `supervisorAddress` are spec text, NOT spec-schema (the schema example shows them spelled `tlsCertFingerprintSha256` and `supervisorAddress` — actually looking again, the spec at line 356-357 shows exactly camelCase for these two. So those two ARE spec-aligned.).

**On re-read, the actual drift is NARROWER**: the spec schema uses camelCase for `tlsCertFingerprintSha256`, `supervisorAddress` and snake_case for everything else. The implementation matches the spec exactly. **Downgrading this to ALIGNED.** Strike A11.

---

### A12. **MINOR DRIFT** — `ListenerSlots` tuple defines slot 0 as `Listener` not `Listener | ReservedForListenerB`

**Spec ref**: ch03 §1 — `listeners: [ListenerSlot, ListenerSlot]` with `ListenerSlot = Listener | ReservedSlot`.

**Evidence**:
- `listeners/array.ts:21` — `export type ListenerSlots = readonly [Listener, Listener | ReservedForListenerB];`
- Spec wants both slots to be `ListenerSlot = Listener | ReservedSlot`.

**Impact**: Slot 0 cannot hold the sentinel even temporarily. In practice this is fine because slot 0 is always Listener A in v0.3+, and the spec's "swap during transition" scenario doesn't apply. But it's a literal byte-for-byte deviation from the spec's tuple shape.

**Already fixed?**: **No.** Cosmetic only.

---

### A13. **DRIFT** — `WatchSessions` rejection error code is `session.not_owned`, spec implies a more specific code

**Spec ref**: ch05 §5 row "WatchSessions": "`WATCH_SCOPE_ALL` is rejected with `PermissionDenied` in v0.3 (the enum value exists for v0.4 admin principals only)".

**Evidence**:
- `sessions/watch-sessions.ts:458` — when `WATCH_SCOPE_ALL` is rejected, the handler emits:
  `throwError('session.not_owned', 'WATCH_SCOPE_ALL is not permitted on v0.3 (admin scope reserved for v0.4)', { requested_scope: ... });`
- The reused `'session.not_owned'` error detail string was meant for "you tried to access someone ELSE's session". Spec ch04 §2 lists `session.not_owned` as the canonical not-owned code; the `WATCH_SCOPE_ALL` rejection is a different semantic class ("you asked for admin scope you don't have").
- `rpc/errors.ts:65-74` — `STANDARD_ERROR_MAP` ships only 4 codes; `session.not_owned` is reused here for parsimony but does not strictly match the rejection semantic.

**Impact**: 
1. Clients that branch on `(code, error_detail.code) = (PermissionDenied, 'session.not_owned')` will treat the WATCH_SCOPE_ALL rejection identically to a ownership rejection. For v0.3 single-principal this is benign (neither path is hit by Electron normally), but in v0.4 admin scope work the conflation will need to be untangled.
2. The spec doesn't *require* a separate code, but the F1 / R5 task narrative ("scope reserved for v0.4 admin principals only") implies a distinct semantic.

**Already fixed?**: **No.** Mild; safer to add `'scope.admin_only'` (or similar) to `STANDARD_ERROR_MAP` as an additive code.

---

### A14. **MINOR DRIFT** — `SessionEvent` in-memory type only emits `created` / `destroyed`; spec proto adds `updated`

**Spec ref**: ch04 §3 `SessionEvent` oneof — `created`, `updated`, `destroyed`.

**Evidence**:
- `sessions/types.ts` (not re-read in this audit, but the watch-sessions.ts handler at line 209-227 has a `switch (ev.kind)` that only handles `'created'` and `'destroyed'`; the comment at line 200-204 says "v0.3 SessionManager emits only `created` and `destroyed`; an `updated` variant lands in T4.x when PTY state transitions wire in.").
- Proto `SessionEvent` ships all three variants (session.proto:127-132).

**Impact**: Wire surface is forever-stable and shipped; just the daemon-side producer doesn't yet emit `updated`. Aligned with spec phasing — T4.x will add it. **Confirmed ALIGNED for v0.3 freeze; flagged only as a phasing pointer.**

---

### A15. **DRIFT** — `SessionManager` uses local ULID synthesis instead of repo-internal `crash/sources.ts:newCrashId`

**Spec ref**: ch09 §1 footnote — "we do NOT add a `ulid` npm dep".

**Evidence**:
- `sessions/SessionManager.ts:44-116` — implements its own 26-char Crockford-base32 ULID-shaped id generator (`newSessionId`).
- `crash/sources.ts` already exports a `newCrashId` of the same shape (per the SessionManager file's own comment at line 41-43).

**Impact**: Two parallel implementations of the same ULID-shaped synth. Internal code drift; a single shared helper would be preferable per dev.md §1 "do not repeat yourself". Functionally identical; the SessionManager's version is well-commented and TypeScript-strict.

**Already fixed?**: **No.** Recommend extracting to a single `daemon/src/util/ulid.ts` helper in a follow-up. Low priority.

---

## §B — Refinements / corrections to baseline audit rows

### B1. Baseline #24 (T1.4 BindDescriptor enum split) — confirmed CRITICAL, scope is wider than baseline noted

See A5 — three vocabularies, not two. Fix touches `listeners/types.ts`, `transport/types.ts`, AND requires a centralized translator (not just a type alias).

### B2. Baseline #28 (T1.2 Listener trait shape) — confirmed DRIFT

The baseline correctly identifies the trait shape divergence (no `bind` field, no `authChain` field, no `(router)` start signature). This audit refines: the baseline's "shipped fine; diverges from spec snippet" conclusion is correct for the trait fields, but A1 / A2 above show the *consequence* of the divergence — the production wiring never installs an authChain at all. The trait shape drift directly enabled the wiring gap.

### B3. Baseline rows #21/#22/#23/#24/#25/#26/#28/#29/#30 (T1.x family) — collectively re-examined

Each module is internally ALIGNED at the unit level, as the baseline says. The integration is broken (A1-A4). Reviewer baseline rows are correct *per merged PR*; this audit demonstrates that PR-row-by-PR-row "ALIGNED" does NOT compose into "system ALIGNED" without the integration PR. Recommend the next reviewer pass include an explicit "integration row" not tied to any single merged PR.

### B4. Baseline rows #31/#32/#33/#37/#38/#39 (T2.x / T3.x) — confirmed ALIGNED at the unit level

Each handler / interceptor / manager is well-built and matches its spec scope. Same caveat as B3 — wiring into `index.ts`/`runStartup` is missing.

### B5. Baseline #36 / Task #189 (Principal model consolidation) — confirmed ALIGNED post-fix

`auth/principal.ts` is the single canonical Principal module; `principalKey` matches spec ch05 §1 verbatim. No latent duplicate found.

### B6. Baseline-implicit T2.4 (RequestMeta validation) — refine to DRIFT per A7

Baseline row marked ALIGNED. A7 above identifies the duck-type fallback as a tolerated-but-undocumented widening; demote to DRIFT with the clarification that it is low-impact.

---

## §C — Confirmed-still-latent items from the baseline that survive deep re-read

| Baseline row | Status after deep re-read |
| --- | --- |
| #17 T0.8 ci.yml monolithic vs spec ch11 §6 5-job DAG | Confirmed CRITICAL DRIFT (this audit did not rescope T0.x) |
| #24 T1.4 BindDescriptor enum vocabulary split | Refined (B1) — wider than baseline; still CRITICAL |
| #28 T1.2 Listener trait field shape | Confirmed DRIFT (B2); coupled with A1 |
| #67 / T6.7 per-stream reconnect backoff unimplemented | Out of scope for this sub-audit (T6.x) |
| #85 / T7.7 Windows MSI scope gap | Out of scope (T7.x) |

---

## Summary

- **Audited surface**: T1.1-T1.9 (daemon listener subsystem, transports, descriptor, supervisor server, peer-cred extractors), T2.1-T2.5 (proto stubs, ConnectRouter, Hello, RequestMeta middleware, ErrorDetail), T3.1-T3.3 (Principal, SessionManager + event bus, WatchSessions handler).
- **New CRITICAL DRIFT**: 5 (A1 peer-cred chain unwired in production; A2 Hello handler unwired; A3 descriptor file never written; A4 Supervisor server never instantiated; A5 confirms baseline #24 is wider — three-vocabulary split).
- **New DRIFT**: 4 (A6 loopback PID-synthesis missing; A7 duck-type meta validation; A9 listener id open-typed + dual-constant split; A10 interceptor order inverted vs spec implicit).
- **New MINOR DRIFT**: 2 (A8 contract test filenames; A12 ListenerSlots slot 0 too narrow).
- **New observation, not drift**: 2 (A14 SessionEvent updated variant phasing; A15 ULID gen duplicated with crash module).
- **Withdrawn finding**: 1 (A11 — re-read spec, descriptor field naming actually IS spec-aligned).
- **Refinements to baseline audit**: 6 rows touched (B1-B6), zero baseline rows overturned.

### Top 3 NEW critical findings (not in the baseline) — ordered by ship-risk

1. **The production daemon wires NEITHER peer-cred auth NOR Hello/WatchSessions handlers into the Connect router (A1 + A2)**. Every internal module (auth interceptor, hello handler, watchSessions handler, peer-cred extractors, native-addon callback seam) is correctly built and unit-tested in isolation; `index.ts` calls `makeRouterBindHook()` with empty options, so production runs as stubs-only with no auth chain. This is the hidden integration gap that explains why every baseline T1.x/T2.x/T3.x row reads ALIGNED while ship-gate (a) is structurally unreachable. Fix is one new module (transport-level `'connection'` event handler that calls the per-OS extractor and writes `PEER_INFO_KEY`) plus a new `index.ts` wiring block (instantiate `SessionManager`, build `helloDeps` + `watchSessionsDeps`, pass them and `peerCredAuthInterceptor` into `makeRouterBindHook(...)`). Native addon for `getsockopt(SO_PEERCRED)` / `LOCAL_PEERCRED` / `ImpersonateNamedPipeClient` is the prerequisite (currently `auth/peer-cred.ts:75-86` ships only `unsupportedUds/NamedPipeLookup` placeholders). NB: shipping fix order matters — addon FIRST so the bind path can fail loud without it; then the wiring module; then `index.ts`.
2. **The `listener-a.json` descriptor file is NEVER written and the Supervisor server is NEVER instantiated in production (A3 + A4)**. PR #863 shipped the descriptor writer and PR #914 shipped the supervisor server, but neither is called from `runStartup()`. Electron's spec ch03 §3.3 handshake requires the descriptor to exist before any RPC; the supervisor's `/healthz` is the canonical readiness signal. Both are absent. Fix is two `index.ts` additions: (a) `await writeDescriptor(env.paths.descriptorPath, payload)` after `listenerA.start()` succeeds; (b) construct `makeSupervisorServer(...)` with the lifecycle, recovery flag, and shutdown callback, then `await supervisor.start()` BEFORE flipping to `Phase.READY`. Both are ordering-sensitive per spec ch02 §3 step 5. Coupled with A1/A2 — same `index.ts` PR can land all four.
3. **`BindDescriptor.kind` lives in THREE separate vocabularies across listener / transport / descriptor layers (A5)**. Baseline #24 caught the listener-vs-descriptor split; this audit confirms a third vocabulary in `transport/types.ts` (`BoundAddress.kind: 'uds' | 'namedPipe' | 'loopback' | 'tls'` — note `'loopback'` ≠ `'loopbackTcp'`). Spec ch03 §1a says "stringified IDENTICALLY" — currently violated by 3 layers, requiring 2 manual translation hops. Fix is to converge all three layers on the spec vocabulary (`KIND_*` strings) — touches `listeners/types.ts`, `transport/types.ts`, `listeners/factory.ts` switch-cases, `transport/h2c-loopback.ts` BoundAddress.kind value, plus all callers (`rpc/bind.ts:resolveDescriptor` collapses to identity). Forever-stable surface (descriptor JSON is wire to Electron) so the migration must be atomic.
