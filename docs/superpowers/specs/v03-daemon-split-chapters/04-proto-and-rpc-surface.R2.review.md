# R2 (Security) review — 04-proto-and-rpc-surface

## P0

### P0-04-1 — `CreateSessionRequest.env: map<string, string>` is unbounded EoP into the daemon's service account

§3, `CreateSessionRequest`: "`map<string, string> env = 3; // additive env on top of daemon's service env`". Combined with chapter 02 §1's "claude CLI subprocess(es) | daemon's service account" and the absence of any allowlist on env keys/values, an unprivileged caller can inject:
- `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` → arbitrary code in the privileged service account.
- `PATH=/tmp/attacker` → if `claude_binary_path` is unset, daemon resolves `claude` from this PATH → code exec.
- `NODE_OPTIONS=--require /tmp/attacker.js` → if claude is implemented in Node anywhere in the chain.
- `SSL_CERT_FILE=/tmp/attacker.pem` → MITM Anthropic API.
- `LD_AUDIT`, `GIO_EXTRA_MODULES`, `XDG_DATA_DIRS`, etc.

Spec MUST define an explicit env **allowlist** (not blocklist; blocklists always lose to new env vars Linux/glibc/macOS adds), e.g., the only client-supplied keys that pass are `[A-Z_][A-Z0-9_]+` matching `CLAUDE_*` or a documented short list. Everything else is dropped before `spawn`.

### P0-04-2 — `CreateSessionRequest.claude_args: repeated string` is unsanitized argv passed to a subprocess

§3 same RPC: "`repeated string claude_args = 4; // argv for `claude` CLI; daemon prepends binary path`". Two issues:
1. `claude` itself accepts arguments that read/write arbitrary files (`--mcp-config /path/to/secrets`, `--output /etc/passwd` if it had write opts, etc.). The argv is a privilege boundary because the daemon's service account may have write access to paths the calling user does not (and vice versa). Spec must say what argv values are rejected.
2. Argument-injection into anything that processes the args downstream (claude itself, MCP servers spawned by claude). The spec treats argv as opaque; this is wrong for a backend that runs as a different uid.

### P0-04-3 — `SettingsService.UpdateSettings` has no admin check; `claude_binary_path` is a code-execution primitive

§6: `Settings.claude_binary_path = 1; // override path to claude CLI`. Combined with chapter 05 §5: "`GetSettings`/`UpdateSettings`: v0.3: open to any local-user principal (settings are global to the daemon install)". Therefore **any local user can call `UpdateSettings({claude_binary_path: "/tmp/attacker.exe"})`**, and the next session anyone creates spawns `/tmp/attacker.exe` running as the daemon's service account. On Linux/macOS this is EoP from `user-A` to `_ccsm`/`ccsm` (which has access to *every* user's session state via the SQLite DB). On Windows it is EoP from interactive user to LocalService.

Mitigations spec must mandate (one of):
- Make `claude_binary_path` immutable after install (set only by installer, not by RPC).
- Gate `UpdateSettings` on admin peer-cred (uid==root/SYSTEM/Administrators) for security-sensitive fields.
- Validate the path is signed by the same authority as the daemon (Authenticode on Win, codesign on mac, debsign on linux).

This finding alone is a P0 ship-blocker.

### P0-04-4 — `PtyService.SendInput.data: bytes` passes raw VT through to the PTY master with no filtering

§4 `SendInputRequest`: "`bytes data = 3; // raw bytes; daemon writes to PTY master`". Per R2 angle 6, spec must define what control sequences are filtered. Concrete attack surface:
- **OSC 52** (clipboard set) — claude session running for hours collects clipboard contents from any process that injects OSC 52 via SendInput.
- **OSC 8** (hyperlinks) — phishing in terminal output.
- **DECSCUSR / DECSET** that change scrollback / alt-screen — confuse session restoration semantics, snapshot fidelity (ch 06 §2 freezes mode bitmap; unknown DECSET may break round-trip).
- **DCS / SOS / PM / APC** sequences which terminals route to printer / terminal-driver hooks.
- **Title-set sequences (OSC 0/1/2)** — change tab title to phishing in Electron's terminal title bar.
- **Bracketed-paste enable (CSI ?2004h)** that desyncs the daemon-side parser and the client-side parser.

Spec should at minimum: enumerate which OSC opcodes are stripped; specify that DCS / APC / PM / SOS payloads are dropped; cite where filtering lives (in the PTY worker before forwarding to `node-pty` master).

## P1

### P1-04-1 — `CreateSessionRequest.cwd: string` is "absolute path; daemon validates exists + readable" — readable by whom?

§3. The validation is from the daemon's POV (its service account) but the meaningful semantics are "the caller can read it". With service-account split, daemon can read paths the caller cannot (e.g., `/var/lib/_ccsm/secret.txt`) and vice versa. Spec must say:
- Validation is "exists + caller-readable", checked via `access(2)` after `seteuid(caller_uid)` or via an explicit ownership check (`stat` + uid comparison).
- Otherwise an attacker can use `CreateSession(cwd="/path/I-cannot-read", ...)` and read it via the spawned claude (which runs as the privileged service account).

### P1-04-2 — `RequestMeta.client_send_unix_ms` is client-supplied, unverified

§2. Used for traceability only per the comment, but if anything (rate limiter, cache, replay-detection) uses it later, attacker controls it. Document it as untrusted; daemon should NOT use it for any auth/freshness decision.

### P1-04-3 — `CrashService.GetCrashLog` returns `detail` (multiline; stack trace) and `labels` to any local-user principal

§5 + ch 05 §5 ("open to any local-user principal in v0.3"). Stack traces commonly include absolute file paths (revealing usernames, install paths, sometimes secrets in env-vars-as-strings). On a multi-user box (linux ccsm group), user-B reads user-A's session-derived crash entries. PII scrubbing must happen at capture time (see review of ch 09).

### P1-04-4 — `Hello.proto_min_version: int32` versioning model conflates wire and feature compat

§3. A monotonically increasing minor is fine for additive proto evolution but doesn't express "I depend on RPC X being present" — a client built against a v0.4 RPC connected to a v0.3 daemon will fail at call time, not at Hello. For v0.3-only this is moot (only one set of RPCs exists), but the **forever-stable** Hello shape locks this in. Recommend adding `repeated string required_rpcs = 5` now (additive, optional) so v0.4+ clients can fail-closed on Hello.

## P2

### P2-04-1 — `Settings.value` per-key TEXT JSON (ch 07 §3) without parameterised mandate

Spec doesn't explicitly mandate that *all* SQL is parameterised; per R2 angle 7. Add a one-line "all queries MUST use prepared statements with bound parameters; no string concatenation" rule.

### P2-04-2 — `ErrorDetail.message` is "human-readable; UI may show" — no length cap, no HTML/ANSI scrubbing

If detail values come from internal exceptions and the UI renders them in HTML (Electron renderer is Chromium), unsanitised render = stored XSS in Settings → Crashes. Cap at 8 KiB; renderer must render as plain text (React JSX defaults to escape).

### P2-04-3 — No proto-level rate-limit field

For v0.3 single-principal local box, rate-limiting is moot. But the additivity contract makes it expensive to retrofit at the RPC level later. Consider a forever-stable optional `RequestMeta.client_idempotency_key` and reserve a `Quota` enum.
