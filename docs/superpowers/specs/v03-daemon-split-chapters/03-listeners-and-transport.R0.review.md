# R0 (zero-rework) review of 03-listeners-and-transport.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 Listener slot 1 reserved only by source-code comment, not enforced

**Location**: `03-listeners-and-transport.md` §1, §6 (also referenced in `02-process-topology.md` §3 step 5)
**Issue**: The fixed 2-slot listener array reserves slot 1 for v0.4's Listener B via a literal source-code comment `// listeners[1] = makeListenerB(env);  // v0.4`. There is no compile-time, type-system, or runtime guarantee that slot 1 stays `null` in v0.3 OR that nothing else gets jammed into it by a well-meaning v0.3.x patch. If any v0.3 patch (telemetry sidecar, debug listener, hotfix) writes into `listeners[1]`, v0.4 will have to (a) move the squatter to a new slot — reshape the array — or (b) renumber Listener B — both UNACCEPTABLE under the zero-rework rule.
**Why P0**: "Any v0.3 listener API that's not symmetric with what B will need" + "Any v0.3 file that must split into multiple v0.4 files" — slot 1 is a v0.4 contract surface enforced by nothing.
**Suggested fix**: Make the reservation type-level and runtime-enforced. Replace `null` in slot 1 with a typed sentinel `RESERVED_FOR_LISTENER_B` (a unique brand symbol exported from `listener.ts`); add a startup `assert(listeners[1] === RESERVED_FOR_LISTENER_B)`; add an ESLint rule that forbids any assignment to `listeners[1]` except inside `listener-b.ts`. v0.4 changes only `listener-b.ts` (replace the sentinel write with `makeListenerB(env)`).

### P0.2 `Principal.cf_access = 2` reserved by proto comment instead of `reserved` keyword

**Location**: `04-proto-and-rpc-surface.md` §2 (cited from this chapter via the auth-chain symmetry argument; the field-number reservation backs Listener B's principal model)
**Issue**: The spec deliberately uses a `// CfAccess cf_access = 2;  // v0.4` *comment* instead of `reserved 2;` inside `Principal.kind`. The justification given ("`reserved` blocks future field number reuse — exactly what we want to prevent") is inverted: the additivity contract in chapter 04 §8.4 explicitly says "**No reuse of any field number, even for previously-unused ones.**" `reserved` is the protobuf mechanism that mechanically enforces exactly that rule. A comment does not.
**Why P0**: This affects the **proto wire schema** — UNACCEPTABLE pattern "Any v0.3 message field whose semantics shift in v0.4". If a v0.3.x patch (e.g., a hotfix adding `ServiceUser service_user = 2;`) ships before v0.4, v0.4's `cf_access = 2` collides and must reshape — exactly the rework the rule forbids. Since the spec also wants `buf breaking` to enforce additivity, that tool will not catch a v0.3.x carelessly grabbing slot 2 because it was never reserved.
**Suggested fix**: In every `oneof` and message that has a v0.4-reserved slot, declare it with `reserved <number>;` (and optionally `reserved "<name>";`). The comment that names the v0.4 intent stays alongside as documentation. Apply the same fix wherever the spec uses comment-only reservation (Principal oneof, any other slot the audit chapter implies).

### P0.3 Listener A descriptor file path is per-user on Windows but written by per-machine LocalService

**Location**: `03-listeners-and-transport.md` §3; `07-data-and-state.md` §2
**Issue**: The descriptor "Windows: `%LOCALAPPDATA%\ccsm\listener-a.json` (or `%PROGRAMDATA%\ccsm\listener-a.json` if cross-user; MUST-SPIKE decides)". `%LOCALAPPDATA%` is per-user; the daemon runs as `LocalService` and does not know which user will launch Electron. The fallback ("write to PROGRAMDATA") works for v0.3 single-user, but in v0.4 the same descriptor mechanism is the only thing the v0.4 Electron talks to (web/iOS use cloudflared and have a separate descriptor) — meaning v0.4 inherits whatever wrong shape v0.3 picked. If the spike picks `%LOCALAPPDATA%`, v0.4 must reshape (LocalService cannot enumerate users). If the spike picks `%PROGRAMDATA%`, semantics already say "per-machine" — fine, but the spec must lock this BEFORE v0.3 ships, not leave the per-OS file path as a moving target.
**Why P0**: "Any v0.3 daemon-side state keyed by something Electron-specific that doesn't generalize". The descriptor location IS daemon-side state and it's keyed by interactive user on one branch of the spike outcome.
**Suggested fix**: Lock Windows descriptor path to `%PROGRAMDATA%\ccsm\listener-a.json` unconditionally (with file ACL granting `BUILTIN\Users` read access). Remove the `%LOCALAPPDATA%` alternative. The spike then only validates that interactive Electron can read this path, not where to put it.

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 `makeListenerB` factory contract changes shape between v0.3 and v0.4

**Location**: `03-listeners-and-transport.md` §6
**Issue**: In v0.3, `makeListenerB(_env)` is documented to **throw**. In v0.4, the same exported symbol returns a `Listener`. The function's effective return type changes (`never` → `Listener`). Callers that handle the throw in v0.3 (none today, but a defensive try/catch could be added) would dead-code in v0.4. This is a soft semantic shift of an exported daemon module.
**Why P1**: Soft-rework risk; not a wire-breaking change but the spec relies on "v0.4 deletes the comment, removes 'throw' from `makeListenerB`" — which IS a v0.4 modification of v0.3-shipped code. The rule prefers "purely additive (new module file)".
**Suggested fix**: Ship `listener-b.ts` in v0.3 with `makeListenerB` exported as `() => null` (returning the same RESERVED sentinel from P0.1) — never thrown. v0.4 replaces the function body to return a Listener. The export signature stays `(env) => Listener | typeof RESERVED`. Cleaner: ship `listener-b.ts` only in v0.4 (additive new file), and v0.3's startup explicitly handles slot 1 as RESERVED with no symbol import.

### P1.2 Per-OS transport pick locked AFTER v0.3 ships could re-leak into Listener B descriptor

**Location**: `03-listeners-and-transport.md` §4, §8
**Issue**: The chapter says "Listener B picks loopback TCP independently". Good. But §4 makes A's transport pick a MUST-SPIKE deferred to implementation. If the spike resolves to A4 (named pipe + h2) on Windows, the descriptor JSON's `transport` enum gains "h2-named-pipe" as a real production value. v0.4 web/iOS clients NEVER see Listener A's descriptor, so this is fine — *unless* a future test/debug client wants to use the descriptor on Windows from a non-Node language. Marginal.
**Why P1**: Documentation-completeness, not architecture. The transport enum string set must be frozen in v0.3.
**Suggested fix**: Lock the descriptor `transport` enum in chapter 03 §3 to the closed set `{"h2c-uds","h2c-loopback","h2-tls-loopback","h2-named-pipe"}` and forbid additions in v0.4 (any new transport ⇒ new descriptor file or new field, never a new enum value). Add this to chapter 15 §3 forbidden-pattern list.

### P1.3 `jwtBypassMarker` middleware shipped in v0.3 but never exercised

**Location**: `03-listeners-and-transport.md` §2
**Issue**: The `jwtBypassMarker` is described as a no-op middleware whose only purpose is "to occupy the same composition position the JWT validator will occupy on Listener B". v0.4 will not literally swap `jwtBypassMarker` for `jwtValidator` (Listener A and B are different listeners with different chains). The marker exists only for code-review symmetry. This is dead code in v0.3 that v0.4 will never touch — small but worth removing the cognitive load.
**Why P1**: Soft-rework risk; the marker pattern invites future contributors to interpret it as a "swap me out" hook, leading to wrong refactors.
**Suggested fix**: Delete `jwtBypassMarker` from v0.3 chains; document the v0.4 chain symmetry as a comment on `makeListenerA`'s authChain literal.
