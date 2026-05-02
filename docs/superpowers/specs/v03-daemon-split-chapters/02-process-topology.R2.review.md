# R2 (Security) review — 02-process-topology

## P0

### P0-02-1 — claude CLI subprocess runs as daemon's service account; user credentials/MCP config inaccessible AND attacker-supplied env unbounded

§1 process inventory row "`claude` CLI subprocess(es) | daemon's service account". On macOS that account is `_ccsm`; on Linux it is `ccsm`; on Windows it is LocalService. The real `claude` CLI loads credentials, MCP config, and project context from the **invoking user's** `$HOME` (`~/.anthropic/`, `~/.config/claude/`, project `.mcp.json`, etc.). When the daemon spawns claude as `_ccsm`/`ccsm`/LocalService:

1. **Functional break**: claude has no access to the user's API key or MCP config — it cannot run at all without the user manually placing credentials into the system-service-account's home dir, which puts secrets in a system-wide location readable by privileged accounts.
2. **Security regression**: any solution the user adopts ("symlink my `~/.anthropic` into `/var/_ccsm/`", or "set `ANTHROPIC_API_KEY` in `Settings`") leaks the user's API key to whatever account can read the daemon's state — including any future v0.4 web/iOS principal that hits the same daemon.
3. **EoP via env**: `CreateSessionRequest.env` (chapter 04 §3) is a `map<string, string>` written verbatim into a process running as a different uid. An unprivileged caller can set `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` / `PATH` / `NODE_OPTIONS` and execute code in the privileged service account's context.

Spec must answer: which uid does claude actually run as, where do its credentials come from, and which env vars are scrubbed/allowlisted before the spawn. None of `02`, `04 §3`, `05 §6`, `07`, `09 §1` address this. Brief §7 says "Why not LOCAL_SYSTEM: principle of least privilege" — but the same argument forbids running claude (which needs the user's secrets) as a privileged service account.

### P0-02-2 — `shutdown` RPC peer-cred check is unspecified for Supervisor's plain-HTTP transport

§4: "`shutdown` RPC on Supervisor UDS: only callable by an admin (peer-cred uid == root/SYSTEM/Administrators)". Chapter 03 §7 says the supervisor is **plain HTTP**, not Connect, "callable by `curl` from the installer / a postmortem shell". There is no spec for how the plain-HTTP server obtains peer-cred per-request, no auth-middleware analogue to the Listener A chain, and no defined behaviour for the loopback-TCP fallback supervisor (`127.0.0.1:54872` per ch 03 §3) where peer-cred is PID-lookup-synthesised. On the loopback fallback, ANY local user can `curl` `/shutdown` and the spec has no defined rejection path. Either:
- Mandate UDS-only for supervisor (drop the loopback-TCP supervisor descriptor field), or
- Define an explicit per-OS peer-cred + uid-allowlist middleware for the supervisor.

### P0-02-3 — Connection descriptor `listener-a.json` is not specified as atomically written, freshness-tagged, or rejected when stale

§3 "Startup order" step 5: daemon "bind Listener A; ...; Supervisor `/healthz` returns 200". Chapter 03 §3 then writes the descriptor "on every successful Listener A bind". Nothing in this chapter or chapter 03 mandates:

1. **Atomic write** (write to temp + `rename(2)`) — partial writes during crash leave Electron parsing truncated JSON or, worse, mixed old/new content.
2. **Per-boot nonce** in the descriptor — e.g., `boot_id` (random per daemon start) and `bind_unix_ms`. Without it, Electron cannot detect a stale descriptor pointing at a recycled port now owned by an unrelated process.
3. **Electron-side staleness rejection** — Electron must verify (via Supervisor `/healthz` echoing the same `boot_id`) that the descriptor it just read corresponds to the daemon currently listening, before sending any RPC.

Race scenario: daemon crashes hard (no graceful unlink); ephemeral TCP port `54871` recorded in `listener-a.json` is bound by some other process; Electron connects and sends `Hello` containing `client_version`/PID/uid info to a foreign process.

## P1

### P1-02-1 — Linux installer adds the user to a process-account group; group is shared across all installs and never trimmed

§2.3: "installer adds the installing user to group `ccsm` (postinst, requires logout/login)". Spec must specify:
- Uninstall removes the user from the group (current §5 only `userdel ccsm` in purge mode; group membership on remaining users not addressed).
- The `ccsm` group's *only* purpose is daemon-socket access; if any other file/dir is accidentally chowned `:ccsm`, every group member gets it.

### P1-02-2 — Cross-user reachability of `/run/ccsm/listener-a.json` (Linux) and `/Library/Application Support/ccsm/listener-a.json` (macOS) is undefined w.r.t. mode

Chapter 07 §2 says daemon state paths are `mode 0700` for the service account. But Electron (per-user, NOT in the service account on macOS where it runs as the logged-in user) MUST read `listener-a.json` to learn the transport. The chapter does not reconcile: if the file is `0700 _ccsm:_ccsm`, Electron cannot read it. Spec must explicitly specify the descriptor file's mode/group (likely `0640 root:ccsm` or `0644`) separately from the rest of state.

### P1-02-3 — Recovery policy "after 2 failures, run no command" with no operator-visible alert

§2.1: third+ failure → "run no command (let crash log capture, see [09])". But chapter 09 §1 only captures `uncaughtException` etc. inside the running daemon — once the service is in stopped state, nothing surfaces a UI banner, sends a notification, or even maintains a tray indicator (Electron polls Listener A and sees `UNAVAILABLE`, but ch 08 §6 says "non-blocking banner Reconnecting..." indefinitely). Persistent "Reconnecting..." with no escalation to "Daemon failed; check Settings → Crashes" is a security-relevant UX failure (user assumes session is alive when it is not).

## P2

### P2-02-1 — `/Library/LaunchDaemons/com.ccsm.daemon.plist` ownership/mode not pinned

macOS launchd refuses to load plists not owned by `root:wheel` mode `0644`, but spec should state this explicitly so the installer is not free to leave the plist user-writable (which would let a local attacker rewrite `ProgramArguments` and pivot to root on next reload).

### P2-02-2 — Windows binary path ACL not restated

`%ProgramFiles%\ccsm\ccsm-daemon.exe` runs as LocalService. Default NTFS ACL on `%ProgramFiles%` denies non-admin write, but the spec should explicitly mandate "installer MUST NOT relax ACL on `%ProgramFiles%\ccsm`" — if the install path is ever moved to `%LOCALAPPDATA%` (per-user) or `%PROGRAMDATA%`, attacker writes to the binary and the next service start is EoP to LocalService.

### P2-02-3 — `should_be_running` automatic respawn on boot has no kill-switch

§3 step 4: daemon respawns claude for every `should-be-running` session. If a session is poisoned (claude args chosen by attacker via prior `CreateSession`), every reboot re-executes the attacker's argv. There must be an admin override (e.g., a Supervisor RPC `quarantine_session(id)`) for incident response.
