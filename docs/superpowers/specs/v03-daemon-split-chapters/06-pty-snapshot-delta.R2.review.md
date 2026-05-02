# R2 (Security) review — 06-pty-snapshot-delta

## P1

### P1-06-1 — Raw VT delta passthrough means OSC 52 / OSC 8 / DCS / APC reach the client unfiltered

§3: "A delta payload is **a contiguous slice of raw VT bytes** as emitted by `node-pty` master. No re-encoding, no escape-sequence parsing on the daemon side before storing." The rationale is fidelity, but every byte the claude subprocess emits is forwarded to:
- The Electron renderer's xterm (which honours OSC 52 → clipboard write, OSC 8 → hyperlink, OSC 0/1/2 → window title).
- v0.4 web/iOS clients (same).
- The daemon-side xterm-headless (state machine; less impact).

A compromised claude (or an attacker who can inject bytes into the PTY via SendInput-as-input then loopback) can:
- Hijack the user's clipboard via OSC 52 (xterm's CSI ?52 modes vary by build; spec must specify the policy).
- Plant phishing hyperlinks via OSC 8 in code blocks the user trusts.
- Set the Electron window title to spoof the OS taskbar.

Spec must specify a filter policy: either a strict allowlist of OSC opcodes (0, 1, 2, possibly none) and a hard drop of DCS/SOS/PM/APC payloads, OR an explicit "we trust the PTY contents because the user trusts what they ran" stance documented as a known risk. Currently the spec is silent.

### P1-06-2 — Snapshot scrubbing path is undefined; SnapshotV1 contains live cell data including secrets

§2: SnapshotV1 includes every cell (codepoint + attrs) of scrollback + viewport. Per ch 09, snapshots may end up surfaced to the user via crash logs / settings (the snapshot itself isn't, but the same bytes are persisted to SQLite). Per the v0.4 upload path the brief flags as a future concern, snapshots are the largest PII vector (every API key the user pasted, every prompt, every tool output). Spec must:
- Mandate snapshots are NEVER included in any RPC accessible to a non-owning principal.
- Plan now for redaction-at-capture if v0.4 upload reuses the same payloads.

### P1-06-3 — Worker-thread isolation does not isolate memory; xterm-headless parser is large attack surface

§1 + ch 15 §4 reviewer-attention #1 already raises this. With multiple sessions (eventually multiple principals) sharing one daemon process, a parser bug in xterm-headless triggered by a malicious PTY stream allows reading another session's snapshot bytes from heap. The spec acknowledges and defers; per security R2 angle 11 "if a future bug accidentally instantiates B without JWT middleware, the surface is exposed" — same logic applies to worker-shared address space. Recommend mandating `child_process` per session OR `Worker` with `--experimental-permission` Node 22 permission model so a compromised parser cannot read SQLite handle / network sockets.

## P2

### P2-06-1 — `pty_delta` table grows unbounded without per-principal quota

§4 retention is per-session "DELTA_RETENTION_SEQS = 4096" entries above the latest snapshot. A long-running session at 256 deltas/30s = many MB. A malicious caller who creates many sessions exhausts SQLite size on disk → daemon `crash_log` fires (ch 09) — but no quota in spec. Add per-principal session count + total bytes cap.

### P2-06-2 — Multi-attach broadcast does not authenticate per-subscriber re-auth

§6: "There is no per-subscriber back-pressure beyond Connect's HTTP/2 flow control". Each subscriber went through Listener A peer-cred at connection time, so they're authenticated. But if peer-cred is per-connection (P2-03-1), and a v0.4 scenario sees one HTTP/2 connection multiplex multiple sessions across principals, this assumption breaks. Pin "every subscriber's principal MUST be the session's owner; verified per-Attach RPC" explicitly.

### P2-06-3 — `claude_args` stored in session record + re-replayed on boot interacts with snapshot replay

§7 daemon-restart replay: snapshot then post-snapshot deltas re-applied. If the recorded snapshot bytes contain attacker-controlled VT (because the attacker once influenced PTY output), every daemon restart re-executes those VT sequences against a fresh xterm-headless. Most VT is idempotent; OSC 52 (clipboard) on Electron reattach **fires every time**. Cross-ref P1-06-1 — filter policy must apply on replay too.

### P2-06-4 — `PtySnapshot.screen_state` is `bytes` (opaque to clients) — version negotiation

§2 mentions `schema_version` and "daemon and client both retain code for every shipped version forever." If a v0.5 client connects to a v0.3 daemon and the snapshot is `schema_version=1`, fine. If a v0.3 client connects to a v0.5 daemon emitting `schema_version=2`, the v0.3 client cannot decode. Spec must say: daemon picks the highest snapshot version the client advertises support for in `Hello` (currently no field for this — would need to add one now).
