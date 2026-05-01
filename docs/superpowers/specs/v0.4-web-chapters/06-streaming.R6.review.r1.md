# Review of chapter 06: Streaming and multi-client coherence

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P2-1 (nice-to-have): "subscriber" vs "client" vs "session listener" — interchangeable but not declared

**Where**: throughout chapter 06:
- §1 line 22: "Connect-Web is half-duplex"; "PTY input over a separate unary RPC"
- §5 line 119: "Each **subscriber** (Electron, web, future client) on `streamPty(...)`"
- §5 line 123: "every active **subscriber's** stream"
- §5 line 130: "Concurrent inputs from desktop + web"
- §6 line 138: "client retains last-seen `seq`"
- §7 line 149: "1 MiB **per-subscriber** buffer high-water mark"

Cross-chapter: 03 §3 line 70 says "single shared HTTP/2 session for all calls"; 02 §3 line 71 says "Connect routes per-method, not per-service".

**Issue**: "subscriber" and "client" are used interchangeably but mean subtly different things:
- *client* = an app instance (one Electron, one web tab) — has many streams.
- *subscriber* = one stream subscription on one session, by one client. One client subscribed to 3 sessions = 3 subscribers.

The drop-slowest cap in §7 ("1 MiB per-subscriber") relies on the *subscriber* meaning. Reader reading "per-client" would assume a client-level cap and miscompute memory budgets.

**Why P2**: chapter 06 is internally consistent enough that an attentive reader can tell apart from context; but a glossary would prevent fixer/implementer confusion.

**Suggested fix**: at chapter 06 §1 add term key:

> "**Client** = an app instance (one Electron process, one browser tab). **Subscriber** = one open server-stream RPC on one session by one client. One client may have N subscribers (N streams to N sessions)."

Apply consistently in §5 and §7; existing prose already mostly conforms.

### P2-2 (nice-to-have): Field-naming convention (snake_case in proto, camelCase in TS) not stated

**Where**: 06 §2 proto block uses snake_case: `boot_nonce`, `session_id`. 06 §6 TS prose uses camelCase: `lastSeenSeq[sessionId]`, `bootNonce`. Also `currentSeq` (camelCase) co-occurs with `boot_nonce` (snake_case) in the same paragraph at §6 line 137.
**Issue**: The convention is standard protobuf-ES (proto field `boot_nonce` → generated TS property `bootNonce`). Reader familiar with protobuf-ES infers this. Reader new to it sees inconsistency.
**Suggested fix**: at 02 §3 (or 06 §2) add one sentence: "**Field-naming convention:** proto fields are `snake_case` per Buf/Google style; the protoc-gen-es codegen exposes them in TS as `camelCase` (e.g. proto `boot_nonce` → TS `bootNonce`)."

### P2-3 (nice-to-have): RPC method-naming inconsistency

**Where**:
- 06 §1 line 25: `client.streamPty({...})` — camelCase TS client.
- 06 §3 line 70: `rpc SendPtyInput(SendPtyInputRequest) returns (SendPtyInputResponse);` — proto PascalCase.
- 06 §5 line 125: `GetPtySnapshot(sessionId)` — proto PascalCase referenced in prose.
- 06 §6 line 137: `streamPty({sessionId, fromSeq})` — TS camelCase.

**Issue**: same convention as P2-2 (proto PascalCase RPC name → generated TS camelCase method) — fine if convention stated. Currently implicit. Same fix as P2-2: state the convention once in 02.

## Cross-file findings (if any)

- P2-2 / P2-3 (snake_case ↔ camelCase, PascalCase ↔ camelCase conventions) bundle into 02 §3 single fix; covers chapters 03, 06 ambiguity simultaneously.
