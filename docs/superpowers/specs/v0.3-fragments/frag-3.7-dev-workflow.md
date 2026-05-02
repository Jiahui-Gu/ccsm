# Fragment: §3.7 Dev workflow (hot-reload + auto-reconnect)

**Owner**: worker dispatched per Task #938 (round-3 fixes by §3.7 round-3 fixer).
**Target spec section**: new §3.7 in main spec (after §3.6).
**P0 items addressed**: #13 (dev hot-reload + auto-reconnect).
**Round-1 review source**: `~/spike-reports/v03-review-devx.md` MUST-FIX 1, 2, 4 + OPEN q1.
**Round-2 review sources** (P0/P1 folded in): `~/spike-reports/v03-r2-devx.md`
P0-1/P0-2/P0-3/P0-4/P0-5 + P1-3/P1-6/P1-7; `~/spike-reports/v03-r2-reliability.md`
P0-R1 + P1-R1; `~/spike-reports/v03-r2-resource.md` P0-1; `~/spike-reports/v03-r2-ux.md`
P0-UX-1 + P0-UX-2 + P1-UX-1 + P1-UX-4 + P1-UX-6.
**Round-3 review sources**: `~/spike-reports/v03-r3-ux.md` P0-UX-A (surface
registry duplicate) + CC-1 (close-to-tray key drift) + CC-3 (i18n casing) +
CC-4 (BridgeTimeout three statements); `~/spike-reports/v03-r3-resource.md`
X2 (pino-roll symlink) + X4 (close_to_tray key drift);
`~/spike-reports/v03-r3-fwdcompat.md` cross-frag #2 (`bootNonce` camelCase
lock); `~/spike-reports/v03-r3-observability.md` P1-2 (reconnect canonical
log names cross-ref); `~/spike-reports/v03-r3-reliability.md` CF-3
(supervisor-disabled-in-dev clarification); `~/spike-reports/v03-r3-devx.md`
P1-1/P1-2/P1-3/P1-4/P1-5 (tray Quit semantics, in-flight chunks, npm rebuild
syntax, Win Get-Content caveat, e2e pkill target).

**Round-3 manager arch decisions (LOCKED)**:
1. Surface registry CANONICAL = frag-6-7 §6.8 (numeric priority, single
   `daemonHealth` IPC, single `useDaemonHealthBridge` hook). §3.7.8 in this
   fragment is **DELETED** and replaced with a one-paragraph cross-ref.
2. close-to-tray SQLite key = `close_to_tray_shown_at` (timestamp), owned by
   frag-6-7 §6.8. §3.7.8.b (which had been claiming `close_to_tray_hint_shown`
   boolean) is collapsed into the §3.7.8 deletion.
3. Per-user install (`%LOCALAPPDATA%\ccsm\`) + OS-native data root —
   see frag-11 §11.6 for dataRoot single source
   (`%LOCALAPPDATA%\ccsm\` Win, `~/Library/Application Support/ccsm/` mac,
   `~/.local/share/ccsm/` Linux). The `daemon.lock` resolution in §3.7.2's
   `wait-on file:` snippet uses the OS-native data root, not the install root.
4. `bootNonce` is camelCase across the bundle (subscribe response, hello
   reply, healthz payload, stream heartbeat). §3.7.5 reader is fixed below.
5. i18n keys are dot+camelCase across the bundle (`daemon.crashLoop`,
   `daemon.unreachable`, `daemon.reconnected`, etc.).
   [manager r7 lock: r6 ux P0-1 — key spelling aligned to §6.8 canonical
   set after the r7 row trim. The r5/r6 spellings `daemon.reconnectStuck`
   and `daemon.reconnectExhausted` are OBSOLETE; reconnect-exhaustion is
   folded into the single `daemon.unreachable` banner per §6.8 r7 cut.
   Likewise `tray.closeHint` is OBSOLETE per §6.8 r7 close-to-tray
   onboarding deletion.]
6. `BridgeTimeoutError` is NEVER user-surfaced per-call; user-facing
   surfacing for the spike (3+ in 10s) and reconnect-exhaustion case is
   absorbed into the canonical surface registry (frag-6-7 §6.8) under
   the single `daemon.unreachable` banner slot per the §6.8 r7 trim
   (separate `bridge_timeout_spike` / `reconnect_exhausted` slots are
   cut; `reconnecting` is log-only at the per-attempt level).
7. Supervisor in dev (`CCSM_DAEMON_DEV=1`): the supervisor process /
   restart loop / crash-loop counter is **disabled**, but the renderer's
   `/healthz` polling continues purely as a status-badge signal. The
   supervisor transport in the daemon STILL binds in dev (else there is
   nothing to poll); only the supervisor-side restart logic is gated off.
   Matches frag-6-7 §6.1.
8. [manager r5 lock: 'Reinstall ccsm' is prose text not a button; matches current working installerCorrupt pattern; v0.3 is refactor scope = no new auto-update feature.]
9. [manager r5 lock: 'View log' button removed entirely; no such feature in current working; v0.3 refactor scope = no new features. Crash log location is documented in frag-11 §11.6 paths table for users who want to find logs manually.]

---

## 3.7 Dev workflow

### 3.7.1 Goals

Daily dogfood loop must stay **≤5 s edit→reload** even after the daemon split.
The devx review (`v03-review-devx.md` §3 MUST-FIX 1) measured that, without
the contents of this section, every `daemon/**` edit costs **+10–15 s and
two manual steps** (`pkill -f dist-daemon` + restart Electron). That budget
is unacceptable across the ~125 h of v0.3 implementation, so the dev tooling
ships **with Phase 0**, not as a Phase 5 afterthought.

### 3.7.2 `npm run dev` topology (v0.3)

The existing v0.2 root script (see `package.json`):

```json
"dev": "concurrently -k -n web,app -c blue,magenta \"npm:dev:web\" \"npm:dev:app\""
```

extends to **three** named processes. Replace with:

```json
"dev":        "concurrently -k -n web,daemon,app -c blue,yellow,magenta \"npm:dev:web\" \"npm:dev:daemon\" \"npm:dev:app\"",
"dev:web":    "webpack serve --config webpack.config.js --mode development",
"dev:daemon": "nodemon --config nodemon.daemon.json",
"dev:app":    "node scripts/wait-daemon.cjs && tsc -p tsconfig.electron.json && cross-env CCSM_DAEMON_DEV=1 electron .",
"setup":      "node scripts/setup.cjs"
```

> **Cross-platform `wait-on file:` note (closes round-2 P0-2 + R1 OPEN q3;
> round-3 manager arch decision #3 path-root lock):**
> `scripts/wait-daemon.cjs` resolves the daemon lockfile path against the
> **OS-native data root** — see frag-11 §11.6 for dataRoot single source
> (`%LOCALAPPDATA%\ccsm\` Win, `~/Library/Application Support/ccsm/` mac,
> `~/.local/share/ccsm/` Linux); concatenate `daemon.lock` to that root.
>
> Then invokes `wait-on file:<resolved> http://localhost:4100`. The
> previous `tcp:127.0.0.1:0` was a no-op (port 0 resolves immediately) and
> silently let Electron race the daemon's pipe bind, dumping every dev
> boot into the auto-reconnect loop. The lockfile is the same one frag-6-7
> §6.4 mandates daemon write at startup via `proper-lockfile`, so no new
> daemon-side work is needed. Note: per-user install (round-3 lock #3) and
> per-user data both go to `%LOCALAPPDATA%\ccsm\` on Windows under the
> r12 lock (PR #682 `perMachine: true` flipped install root to
> `$PROGRAMFILES64\ccsm\` while data paths stayed at `%LOCALAPPDATA%`);
> see frag-11 §11.6 for the canonical paths table.

Process graph:

```
concurrently -k
├── web     : webpack-dev-server  (HMR for renderer, port 4100)
├── daemon  : nodemon → tsc -w → node daemon/dist-daemon/index.js
└── app     : tsc(electron) → electron .  (spawnOrAttach attaches to nodemon's daemon)
```

`-k` (kill-others) is mandatory: a dead web server must take the daemon and
Electron with it, otherwise stale processes hold the named pipe and the
next `npm run dev` fails the spawn-or-attach probe (Task 7 §3 step 4).

#### 3.7.2.a Workspaces prerequisite (closes round-2 devx P0-1)

`dev:daemon`'s nodemon `exec` (§3.7.3) and `frag-11-packaging.md` §11.1 both
shell out to `npm -w @ccsm/daemon run …`. The repo's current root
`package.json` declares no `"workspaces"` array (verified 2026-04-30 against
working tip). The Phase 0 plan delta below (Task 1) explicitly mandates
adding `"workspaces": ["daemon"]` to root `package.json` so that workspace
flag-syntax resolves on first contributor pull. **frag-11 still owns
`daemon/package.json` scaffolding** (`name: "@ccsm/daemon"`); §3.7 owns the
root-side declaration so the dev script is functional. Cross-frag rationale
captured at the bottom of this document.

#### 3.7.2.b Single canonical daemon entry in dev (closes round-2 devx P0-3 + P1-4)

Two daemon entries are described across the bundle:

- frag-3.7 §3.7.3: `node daemon/dist-daemon/index.js` (TS-compiled, run by nodemon).
- frag-11 §11.2: `daemon/dist/ccsm-daemon-${devTarget()}` (pkg-bundled binary).

These are **not interchangeable**. In `CCSM_DAEMON_DEV=1` mode the
**only** runtime entry is the nodemon-managed `node daemon/dist-daemon/index.js`.
`spawnOrAttach.ts` (Task 7) MUST treat dev mode as attach-only and never
look up the pkg path. frag-11 §11.2 should remove or fence its `devTarget()`
branch behind `!process.env.CCSM_DAEMON_DEV` so the prod-only path doesn't
read as authoritative for dev. **Punt accepted by §3.7 (this fragment) for
the spawnOrAttach side; the frag-11 side is a one-line edit owned by the
frag-11 round-2 fixer** — see Cross-frag rationale.

#### 3.7.2.c Toolchain prerequisites (closes round-2 devx P0-4 + P1-5)

v0.3 introduces a **C++ toolchain requirement** for the daemon's native
helper at `daemon/native/winjob/` (frag-3.5.1 §3.5.1.1, frag-6-7 §6.2).
v0.2 contributors editing only `src/` did not need this. To prevent
first-time-on-Windows `gyp ERR! find VS missing any VC++ toolset`, the
following are mandatory before `npm install` succeeds in a fresh checkout:

| Platform | Required tool | Notes |
|---|---|---|
| Windows | Visual Studio Build Tools 2022 (Desktop C++ workload) | `node-gyp` for `daemon/native/winjob/`. |
| Windows | Python 3.10+ on PATH | `node-gyp` dependency. |
| Windows (signtool path) | Windows 10/11 SDK 10.0.22621.0 | only for `make:win` (frag-11 §11.3.1). |
| macOS | Xcode Command-Line Tools | `xcode-select --install`. |
| Linux | `build-essential`, `python3`, `libsecret-1-dev` | apt/yum equivalent. |

The Phase 0 `npm run setup` script (`scripts/setup.cjs`, added by Task 1)
runs:

```
1. npm install                                              (root + workspaces)
2. npm -w @ccsm/daemon rebuild better-sqlite3 node-pty
   --runtime=node --target=22.x                             (Node 22 ABI)
3. (optional) npm run build:daemon                          (only if running make:*)
```

> **npm rebuild syntax** (round-3 devx P1-3): with the workspaces array
> declared (§3.7.2.a), the canonical syntax is `npm -w @ccsm/daemon rebuild`,
> NOT `npm rebuild --prefix daemon`. The round-2 spec used `--prefix` which
> is redundant with workspaces and confused first-time contributors who
> tried to mirror it elsewhere; locked to the workspace-flag form.

Renderer-only contributors who never touch `daemon/**` MAY skip step 2 by
running `npm install --workspaces=false && npm run dev:web` (documented in
CONTRIBUTING). The default workspace-aware install does run `node-gyp` for
the native helper — accepted onboarding cost; see Cross-frag rationale for
the wider tradeoff.

#### 3.7.2.d Production dogfood log access (closes round-2 devx P0-5; round-3 devx P1-4)

Prod dogfood (per `feedback_dogfood_protocol`) runs the installed binary
where `stdio: "ignore"` (§3.7.6) hides daemon stderr. The only signal is
the daemon log written by `pino-roll` (frag-6-7 §6.6) under the OS-native
data root (`<dataRoot>/logs/daemon.log` — see frag-11 §11.6 for the
canonical dataRoot paths: `%LOCALAPPDATA%\ccsm\` Win,
`~/Library/Application Support/ccsm/` mac, `~/.local/share/ccsm/` Linux).
Per round-3 manager arch decision #3, log paths follow the OS-native data
root, not `~/.ccsm/`. v0.3 mandates **two** affordances,
both shipped in Phase 0 (no dogfood gate without them):

- **`pino-roll` `symlink: true`** — daemon writes a stable symlink
  alongside dated rotated files. POSIX `tail -F` follows the symlink
  target across rotations cleanly. **Windows caveat (round-3 devx P1-4):**
  `Get-Content -Wait` opens the symlink target by inode at start and
  keeps the handle — it does NOT follow target swaps even with `-Tail`.
  The `pino-roll symlink: true` fix is therefore **POSIX-only** for
  live-tail purposes; Windows users tail via the tray menu "Tail daemon
  log in new terminal" entry below (which spawns `wt.exe` running
  `Get-Content` against the *current* rotated file, re-resolved per
  invocation). **PUNT to frag-6-7 §6.6 fixer**: the `symlink: true` key
  itself lives in frag-6-7's pino-roll config block (round-3 resource
  X2: not yet added in r2 — must land in this round). One-line edit.
- **Log path documentation** — daemon log path is documented in
  release notes / About dialog so users can locate
  `<dataRoot>/logs/daemon.log` manually for support diagnostics. No
  tray menu growth (v0.3 is a refactor — no new tray entries).
  [manager r7 lock: cut as polish — N2# from r6 feature-parity (Win-only
  "Tail daemon log in new terminal") + N3# (cross-platform "Open daemon
  log") — neither exists in working tip; v0.3 is refactor scope.]

### 3.7.3 `nodemon.daemon.json` (new file, Task 1 add)

```json
{
  "watch": ["daemon/src"],
  "ext": "ts,json",
  "ignore": ["daemon/src/**/__tests__/**", "daemon/dist-daemon/**"],
  "exec": "npm -w @ccsm/daemon run build && node daemon/dist-daemon/index.js",
  "signal": "SIGTERM",
  "delay": 150,
  "stdout": true,
  "stderr": true,
  "env": { "CCSM_DAEMON_LOG_LEVEL": "debug", "CCSM_DAEMON_DEV": "1" }
}
```

Key choices:

- **`exec` = build + run, not `tsc -w` separately.** A single `nodemon`
  edit-trigger atomically (a) rebuilds, (b) sends `SIGTERM` to the previous
  daemon, (c) starts the new one. Two-process `tsc --watch` + file-watcher
  custom shim was rejected: nodemon already does it, +0 LOC.
- **`signal: SIGTERM`** matches the daemon's existing handler in
  `daemon/src/index.ts` step 4 (Plan Task 1 step 4 already wires
  `process.on("SIGTERM", () => process.exit(0))`).
- **`delay: 150`** debounces multi-file saves (TS refactor renames touch
  many files in one tick).
- **`stdout/stderr: true`** addresses devx MUST-FIX 2 — daemon errors land
  in the same terminal pane as the renderer/Electron logs. Pino still
  writes its structured stream to `~/.ccsm/logs/daemon.log` for post-mortem,
  but stack traces appear inline.

### 3.7.4 Connect client auto-reconnect

When nodemon restarts the daemon, the Electron-side Connect client (Task 7
§3 `connectClient.ts`) sees its socket close. Today (Plan Task 7 step 4,
unmodified) the client throws on next call and the renderer surfaces a raw
`ECONNREFUSED`. v0.3 §3.7 mandates **transparent auto-reconnect**:

#### Backoff schedule

Exponential, doubling, capped, with full jitter:

| Attempt | Base delay | With ±25 % jitter |
|---------|-----------:|------------------:|
| 1       | 200 ms     | 150–250 ms        |
| 2       | 400 ms     | 300–500 ms        |
| 3       | 800 ms     | 600–1000 ms       |
| 4       | 1600 ms    | 1200–2000 ms      |
| 5       | 3200 ms    | 2400–4000 ms      |
| 6+      | **5000 ms (cap)** | 3750–5000 ms |

No retry cap on attempt count — the client retries forever until either
(a) the socket connects, (b) the user quits the app, or (c) Task 7's
`spawnOrAttach` is invoked again with `spawnIfMissing: true` and starts a
fresh daemon. Under nodemon's typical 200–600 ms restart window, attempts
1–2 succeed; under prod cold start (pkg binary, ~1.5 s) attempts 3–4
succeed.

#### Bounded reconnect queue

While disconnected, RPC calls are **queued, not rejected**:

- Queue cap: **100** in-flight calls in prod (`MAX_QUEUED_PROD = 100`),
  **1000** in dev (`MAX_QUEUED_DEV = 1000`) — closes round-2 reliability
  P1-R1 (rapid-fire dev save can briefly exceed 100 in nodemon storms;
  RAM cost ~200 KB).
- On overflow: oldest call is rejected with
  `Error("daemon-reconnect-queue-overflow")`; the renderer's existing
  per-bridge error path surfaces this.
- Stream subscriptions (PTY data, notify) are **not queued** — see
  §3.7.5 resubscription.
- On reconnect success: queue drains FIFO; each entry sends its
  envelope and resolves/rejects the original promise.

Rationale: 100 calls @ ~200 B JSON envelope = ~20 KB worst-case in-memory
buffering, well below any concern. The cap exists to bound an
adversarial-disconnected-forever case (e.g. daemon binary missing); it is
not a steady-state limit.

#### 3.7.4.a Reconnect-queue does NOT double-buffer stream replay (closes round-2 resource P0-1)

The reconnect queue holds **unary** RPC envelopes only. Stream
**resubscription** (§3.7.5) does NOT replay through the queue. To bound
the daemon-side replay burst when `subscribe(fromSeq)` requests a
sequence older than the daemon's ring buffer, frag-3.7 picks resolution
(b) of round-2 resource P0-1: the per-subscriber 1 MB drop-slowest
watermark in **frag-3.5.1 §3.5.1.5 is measured AFTER the initial replay
burst is delivered**, not as part of slow-subscriber accounting.
Equivalently, the replay burst is treated as one initial write and
exempt from slow-subscriber drop-decision. **Cross-fragment contract:**
frag-3.5.1 §3.5.1.5 round-2 fixer must add a one-sentence carve-out
("initial replay burst on resubscribe is not counted toward the 1 MB
per-subscriber drop-slowest watermark"). **Punt to frag-3.5.1 round-2
fixer**, called out here so the contract is visible.

If frag-3.5.1's fixer rejects (b), §3.7.5 falls back to resolution (a):
client clamps `fromSeq` such that the daemon ships at most 256 KB of
replay then declares `gap: true`. The toast/divider path in §3.7.5
already handles `gap: true` cleanly so this is a graceful fallback.

#### Toast UX — registers into frag-6-7 §6.8 surface registry

The reconnect bridge does NOT own a toast vocabulary; it publishes into
the canonical surface registry defined in **frag-6-7 §6.8** (locked by
round-3 manager arch decision #1). The reconnect bridge contributes the
following surfaces; priorities/stacking/dedup are §6.8's responsibility.
i18n keys are dot+camelCase per round-3 lock #5:

| Event | §6.8 slot (priority) | i18n key |
|---|---|---|
| 1st reconnect attempt fails (250 ms threshold) | LOG ONLY (no IPC publish) — `daemon.reconnecting` toast slot CUT in §6.8 r7 trim | `daemon.reconnecting` (log-only) |
| Reconnected (queue drained) | `reconnected` (transient info, 3 s TTL) | `daemon.reconnected` |
| Queue overflow rejection | LOG ONLY — `queueOverflow` toast slot CUT in §6.8 r7 trim | `daemon.queueOverflow` (log-only) |
| Reconnect attempts continue past supervisor miss threshold | promote to `unreachable` (red banner, P=70) — folded the former N=15 `reconnectExhausted` modal into the same banner per §6.8 r7 trim | `daemon.unreachable` |
| Bridge-timeout spike (3+ in 10 s) | LOG ONLY — `bridgeTimeoutSpike` slot CUT in §6.8 r7 trim (escalates into `daemon.unreachable` if it persists) | (log-only) |
| Stream gap on resubscribe | LOG ONLY (xterm divider may still render renderer-side) — `streamGap` toast slot CUT in §6.8 r7 trim | `daemon.streamGap` (log-only) |
| Dev-mode build error (queue >4 s in `CCSM_DAEMON_DEV=1`) | LOG ONLY — `devBuildError` slot CUT in §6.8 r7 trim | `daemon.devBuildError` (log-only) |

The 250 ms hold-off (renderer-side, owned by `useDaemonReconnectBridge`)
prevents flicker: nodemon restarts in ~200 ms, so a clean dev-loop edit
shows **no surface at all** — the 1st backoff retry (200 ms) succeeds
before the publish threshold fires. The dev-mode build-error toast
catches the TypeScript-broken-in-nodemon case where the dev terminal has
a useful error but the renderer is otherwise opaque.

`BridgeTimeoutError` per-call is NEVER user-surfaced (round-3 lock #6);
the renderer's bridge layer logs `DEADLINE_EXCEEDED` (gRPC convention)
and lets the supervisor banner (frag-6-7 §6.1) absorb it. After the
§6.8 r7 trim, the only user-visible surface tied to bridge timeouts is
the single `daemon.unreachable` banner (the former `bridgeTimeoutSpike`
toast and `reconnectExhausted` modal slots are cut and folded into
`daemon.unreachable`).

**Canonical log line names** (round-3 obs P1-2 cross-ref): the reconnect
emitter uses the strings declared by **frag-6-7 §6.6.2 "Bridge call
lifecycle log lines"**: `daemon_socket_closed`, `daemon_reconnect_attempt`,
`daemon_reconnect_success`, `daemon_queue_overflow`, `stream_resubscribe`.
Workers MUST NOT invent new strings (e.g. `reconnect-attempted`).

**Tray-mode "Quit" semantics** (round-3 devx P1-1): the existing
working tray menu (`[Show CCSM | Quit]`) Quit handler MUST call
`app.quit()` (clean exit, drain pino, release lockfile), NOT
`win.close()` (which only hides to tray). The renderer plumbs this via
the existing `tray.quitApp` IPC channel (Task 21). [manager r7 lock:
the former r6 rationale ("the `reconnectExhausted` modal's Quit button
must clean-exit even when in tray-hidden state") is OBSOLETE — that
modal was cut by §6.8 r7; the `daemon.unreachable` banner has no Quit
button (banner is non-blocking). The `app.quit()` requirement still
holds for the working tray-menu Quit, which is the only Quit affordance
in v0.3.]

### 3.7.5 Stream resubscription on reconnect

Devx OPEN q1: "When daemon restarts mid-session under dev, every renderer
subscription drops." The bridge **must auto-resubscribe** rather than
reload the renderer (renderer reload would lose terminal scrollback and
form state).

On reconnect success, `connectClient`:

1. **First, tears down stale stream handles.** Iterates every entry in its
   internal stream-handle table and calls `.cancel()` on each, clearing
   any client-side `setInterval` heartbeat timers (frag-3.5.1 §3.5.1.4)
   and removing them from the stream-handle table. This closes round-2
   devx P1-6 — without it, two client-side heartbeat timers per stream
   accumulate per restart and never get cleared.
2. **Then, walks `Map<sid, SubscriptionDescriptor>`** populated at
   `subscribe()` time. For each entry it re-issues the subscribe RPC
   with `fromSeq = lastSeenSeq + 1`. PTY service (Task 11) and notify
   service (Task 13) MUST honor `fromSeq` — this is on their wire
   contract per §3.5.1 (PTY hardening fragment) and §3.4.1 (envelope
   hardening fragment). The canonical declaration of the
   `subscribe(sessionId, { fromSeq })` shape lives in **frag-3.4.1
   §3.4.1.b** per the round-2 fwdcompat call (P1-1); §3.7.5 references
   it rather than re-stating shape.
3. **bootNonce check (closes round-2 fwdcompat P1-1; round-3 fwdcompat
   cross-frag #2 camelCase lock).** Each subscribe response includes the
   daemon's `bootNonce` field — **camelCase**, locked by round-3 manager
   arch decision #4 (declared by frag-6-7 §6.5 healthz, frag-3.4.1 §3.4.1.g
   hello, frag-3.5.1 §3.5.1.4 stream heartbeat; all four sites converge on
   `bootNonce`). If the response `bootNonce` differs from the value
   captured by the most recent subscription on this `sid`, the bridge
   treats `fromSeq` as **invalid** (daemon rebooted, sequence space
   reset) and behaves as if the daemon had returned `gap: true` —
   fresh subscription from `fromSeq = 0`, log `daemon.streamGap` and
   render the xterm divider renderer-side. (The §6.8 r7 trim cut the
   `daemon.streamGap` toast; the divider remains a renderer-side
   affordance, no IPC.) Without this, after a daemon restart the
   client could request `fromSeq=12345` against a daemon whose new
   sequence space starts at 0 and silently miss the first 12345 frames.

   **In-flight chunk dedup across teardown** (round-3 devx P1-2): step 1
   tears down the old socket's stream handles before the resubscribe ack
   arrives, but kernel-buffered chunks from the old socket may still
   land at the renderer between `.cancel()` and the fresh subscribe ack.
   The renderer trusts `seq` ordering only WITHIN a single
   `(sid, bootNonce)` tuple — chunks arriving with a stale `bootNonce`
   (captured at old subscribe time) are dropped silently. Same-bootNonce
   late chunks (nodemon SIGTERM-then-restart of the SAME daemon process
   is impossible because nodemon spawns a fresh node process and
   `bootNonce` is minted at boot) are de-duped by `seq`: any frame with
   `seq <= lastSeenSeq` is dropped.

If `fromSeq` is older than the daemon's ring buffer (cold daemon = empty
ring), the daemon responds with `gap: true`; the bridge logs
`daemon.streamGap` (LOG ONLY — the §6.8 r7 trim cut the toast slot;
no IPC publish) and the renderer's xterm adapter emits a visible
`─── stream gap ───` divider purely as a renderer-side affordance.

### 3.7.6 Dev-mode contrasts vs prod

| Aspect | Dev (`CCSM_DAEMON_DEV=1`) | Prod |
|---|---|---|
| Daemon process | nodemon child of `npm run dev` shell | pkg binary, spawned by `spawnOrAttach` (Task 7) or attached if already running (tray-quit semantics, Task 21) |
| Restart cadence | every `daemon/src/**` save (~5–50×/h) | only on crash, daemon auto-update (Task 23), or explicit tray Quit |
| stdio | inherited (`stdout/stderr: true` in nodemon) | `stdio: "ignore", detached: true` (Task 7 §3 step 4); pino writes to `~/.ccsm/logs/daemon.log` only |
| Log level | `debug` | `info` (overridable via `CCSM_DAEMON_LOG_LEVEL`) |
| Reconnect path | hits often (nodemon SIGTERM) | rare (crash recovery) |
| Toast frequency | usually suppressed by 250 ms hold-off | subject to frag-6-7 §6.8 dedup vs supervisor banner |
| Backoff schedule | **same** (200 ms → 5 s cap) | **same** |
| Stream resubscribe | **same** | **same** |
| Reconnect queue cap | **1000** | **100** |
| Supervisor restart loop (frag-6-7 §6.1) | **DISABLED** — see §3.7.6.a | active |
| Supervisor transport binds (frag-6-7 §6.5) | **YES** (so renderer `/healthz` poll has a target) | yes |
| Renderer `/healthz` polling for status badge | **YES** (diagnostic UI only) | yes |

The reconnect/queue/resubscribe code path is **identical** in dev and prod
— gating it behind `CCSM_DAEMON_DEV` would mean the prod path is exercised
only in the field. Devx review §3 MUST-FIX 2 only differentiates
**logging stdio**, not the client-side reconnect logic. The queue cap
splits dev/prod for ergonomic reasons (see §3.7.4).

#### 3.7.6.a Supervisor restart loop disabled in dev; transport + healthz polling stay (closes round-2 reliability P0-R1; round-3 reliability CF-3)

frag-6-7 §6.1 mandates a supervisor (5 s `/healthz`, 3-miss restart, crash-loop
modal at 5 respawns / 2 min). In `CCSM_DAEMON_DEV=1`, **the supervisor's
restart loop / heartbeat-miss counter / crash-loop counter MUST be disabled**.
Justification: nodemon already supervises the daemon (SIGTERM + restart on
file change); a second supervisor that doesn't know about nodemon will count
every save as a missed heartbeat and trip the crash-loop modal during normal
dev.

What stays in dev (round-3 reliability CF-3 clarification — the r2
"disabled entirely" wording was too strong and conflicted with frag-6-7
§6.1's "still polls /healthz for diagnostic UI"):

- The **supervisor transport** (named pipe / unix socket per frag-6-7 §6.5)
  STILL binds in the daemon, because the renderer needs a target for
  diagnostic-UI `/healthz` polling. Otherwise every nodemon SIGTERM
  would race the renderer's poll and produce flicker.
- The **renderer's `/healthz` poll** (5 s) continues purely as a status-
  badge signal (green/yellow/red dot in the dev tray + dev-mode debug
  panel). It does NOT drive any restart decision.
- The **supervisor's restart loop** (3-miss → restart, 5-respawn-in-2min
  → crash-loop modal) is the part that's gated off behind
  `!process.env.CCSM_DAEMON_DEV`.

frag-3.7's auto-reconnect (§3.7.4) is the dev-mode liveness *response* —
sufficient because (a) the user *is* the failure detector in dev, (b)
reconnect-queue + N=15 modal escalation already surfaces a stuck
daemon, and (c) the diagnostic-UI badge gives a quick visual
confirmation. **Cross-fragment contract:** frag-6-7 §6.1 round-3 fixer
must mirror this exact split (transport + poll on, restart loop off).
Already done per round-3 obs review confirmation that frag-6-7 §6.1 line
25 reads "DISABLED in spawn/restart mode but still polls /healthz for
diagnostic UI." This fragment's r3 edit aligns the wording.

### 3.7.7 Test coverage

- Unit: `electron/daemonClient/__tests__/connectClient.reconnect.test.ts` —
  mock `node:net`, assert backoff schedule (use `vi.useFakeTimers()`),
  queue-overflow rejection, FIFO drain order, dev-vs-prod cap.
- Unit: `electron/daemonClient/__tests__/connectClient.resubscribe.test.ts`
  — verify `Map<sid, SubscriptionDescriptor>` re-issue with bumped
  `fromSeq`; verify `bootNonce` mismatch resets `fromSeq=0` and emits
  the `daemon.streamGap` log line + xterm divider (no IPC publish per
  §6.8 r7 trim); verify stale stream handles `.cancel()` before
  resubscribe.
- E2E: **fold into `harness-agent` as a phase** (closes round-2 devx
  P1-7 / `feedback_e2e_prefer_harness`). New phase
  `harness-agent.daemonReconnect()`: kill the running daemon
  (platform-aware target — round-3 devx P1-5: under prod-installed
  harness use `taskkill /F /IM ccsm-daemon.exe` on Win and
  `pkill -f /Applications/ccsm.app/Contents/Resources/daemon/ccsm-daemon`
  on macOS / `pkill -f /opt/ccsm/resources/daemon/ccsm-daemon` on Linux;
  ONLY in dev-mode harness use `pkill -f dist-daemon/index.js`), assert
  renderer DOM shows `[data-toast-kind="reconnecting"]`, restart daemon
  via `spawnOrAttach`, assert toast clears within 1 s and a follow-on
  RPC succeeds. Avoids +30 s/test for a standalone probe. No skip
  allowed (per `feedback_no_skipped_e2e`).

### 3.7.7.a Debugger attach (closes round-6 devx P0-1)

[manager r7 lock: r6 devx P0-1 — debugger contract for daemon-split contributors]

Three documented attach flows; all env-gated, default off, **dev-only**
(production builds compile-out the inspector flag — security boundary
preventing a packaged installer from exposing a live Node inspector).

- **Daemon (`--inspect=9230`)**: env-gated via `CCSM_DAEMON_INSPECT=1`.
  Nodemon's `exec` line in §3.7.3 becomes
  `npm -w @ccsm/daemon run build && node ${CCSM_DAEMON_INSPECT:+--inspect=9230} daemon/dist-daemon/index.js`.
  Default `npm run dev` opens NO inspector port; `CCSM_DAEMON_INSPECT=1 npm run dev`
  opens 9230. Port 9230 chosen to avoid Electron-main's default 9229.
  Production builds (Task 1 / frag-11 §11.2 packaging path) MUST NOT
  thread this env var into the spawned daemon — `spawnOrAttach.ts` in
  prod mode strips `CCSM_DAEMON_INSPECT` from the child env. Supervisor
  restart-loop is already disabled in dev (§3.7.6.a) so a paused-at-
  breakpoint daemon does not get killed for missed heartbeat;
  auto-reconnect (§3.7.4) retries forever with a 5 s cap, so the
  renderer simply shows the reconnect waiting toast until the
  contributor resumes.
- **Electron-main (`--inspect=9229`)**: existing pattern. `dev:app`
  becomes `node scripts/wait-daemon.cjs && tsc -p tsconfig.electron.json && cross-env CCSM_DAEMON_DEV=1 electron ${CCSM_ELECTRON_INSPECT:+--inspect=9229} .`.
  `CCSM_ELECTRON_INSPECT=1 npm run dev` opens 9229. Port 9229 is the
  Node default and matches existing working-tip Electron-main inspect
  conventions.
- **Renderer**: existing Chrome DevTools (open from the Electron window
  menu / `Ctrl+Shift+I`). No env var needed — devtools availability is
  already gated by `app.isPackaged === false` in the existing renderer
  bootstrap.

**VS Code attach**: add two `attach` configurations to
`.vscode/launch.json` — `Attach to daemon` (port 9230) and
`Attach to Electron-main` (port 9229), plus a `compounds` entry to
launch both simultaneously. Contributors then run
`CCSM_DAEMON_INSPECT=1 CCSM_ELECTRON_INSPECT=1 npm run dev` and select
the compound from the VS Code Run panel.

### 3.7.7.b SDK ownership in v0.3 daemon split (closes round-6 devx P0-2)

[manager r7 lock: r6 devx P0-2 — daemon owns SDK directly (own Node 22 ESM); Electron-main loadSdk shim retained ONLY for any residual session-title/non-daemon SDK calls. New daemon code MUST NOT use the shim.]

The v0.3 daemon process is its own Node 22 process with native ESM
support; daemon-side modules MAY `import` `@anthropic-ai/claude-agent-sdk`
directly (ESM-direct, no shim). The `electron/sessionTitles/loadSdk()`
shim was created for the Electron 33 main process (CJS) needing to
consume the ESM-only SDK; that constraint does NOT apply inside the
daemon. **Daemon-side SDK consumers MUST use direct `import` (or
top-level `await import()` if dynamic), never `loadSdk()`.**

Recommended ownership (manager lock): the daemon owns ALL SDK runtime
use — agent dispatch, streaming, tool execution, model API calls.
Electron-main retains the `loadSdk()` shim ONLY for any residual
read-only / non-daemon SDK call sites that survive the v0.3 split
(e.g. session-title generation if it stays in Electron-main per
existing working-tip placement). New code paths added under the v0.3
plan MUST NOT introduce additional Electron-main SDK consumers; if a
new SDK call is needed, it goes in the daemon. If audit determines
sessionTitles also moves to the daemon in v0.3, the loadSdk shim can
be deleted entirely — flagged for follow-up (frag-12 traceability row,
not in v0.3 scope unless trivial).

### 3.7.8 User-visible surface registry — see frag-6-7 §6.8

**DELETED in round-3** (closes round-3 ux P0-UX-A: two competing
registries). Surface registry is owned canonically by **frag-6-7 §6.8**
(numeric priority 100/90/85/70/50/30, single `daemonHealth` IPC channel,
single `useDaemonHealthBridge` hook, ≤1 modal at a time, explicit
stacking + dedup rules). Every surface this fragment used to own
(reconnect waiting, reconnect-stuck modal, queue overflow, stream gap,
dev-mode build error, bridge-timeout spike, close-to-tray onboarding
hint, pre-mount loader trigger) is now registered into §6.8.

After the §6.8 r7 trim (16 → 7 rows), the dev-mode reconnect bridge
publishes only into the surfaces that survived the cut: priority **70
(red banner)** for `daemon.unreachable` (the former
`reconnectExhausted` modal at N=15 + `bridgeTimeoutSpike` toast +
`healthDegraded` banner are all collapsed into this single banner
slot), priority **30 (transient info toast)** for `daemon.reconnected`,
and priority **85 (modal)** for `daemon.crashLoop`. The polish surface
slots (`reconnecting` toast, `queueOverflow` toast, `streamGap` toast,
`bridgeTimeoutSpike` toast, `devBuildError` toast, `healthDegraded`
banner, `reconnectExhausted` modal) are CUT in §6.8 r7 — log-only,
no IPC publish. Pre-mount loader and close-to-tray hint were also
cut in §6.8 r7 (close-to-tray onboarding deleted entirely; pre-mount
loader subsumed by the existing splash).

i18n keys are dot+camelCase across the bundle (round-3 ux CC-3 lock).
After the §6.8 r7 trim the dispatched-surface keys are
`daemon.unreachable`, `daemon.reconnected`, `daemon.crashLoop`. The
former r6 keys `daemon.reconnecting`, `daemon.queueOverflow`,
`daemon.reconnectExhausted`, `daemon.bridgeTimeoutSpike`,
`daemon.streamGap`, `daemon.devBuildError`, `tray.closeHint` are
OBSOLETE (log-only or deleted entirely). Drafted copy for the surviving
keys lives in **frag-6-7 §6.8 + §6.1.1** copy table; this fragment no
longer owns the strings.

Cross-frag PUNT (one-line for frag-6-7 §6.8 fixer to absorb): the
**dev-mode reconnect surface** has no analog in prod (in prod the
supervisor banner absorbs reconnect waiting per the mutual-exclusion
rule). frag-6-7 §6.8 must add a row for the dev-only `daemon.devBuildError`
surface (the queue-waits->4s-in-CCSM_DAEMON_DEV case from old
§3.7.4 row j) at priority 50; this is the only surface that fires in dev
but not prod. All other former-§3.7.8 rows already have §6.8 equivalents.
[manager r11 lock: PUNT obsolete — §6.8 r7 trim explicitly cut `daemon.devBuildError`; this slot is permanently LOG ONLY per §3.7.5 r7 lock. (historical; no longer relevant)]

---

## Plan delta

Concrete edits to `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`:

### Task 1 (Phase 0 scaffolding) — **+5 h** (was +3 h)

- Add `nodemon` + `cross-env` + `wait-on@^7` to root `devDependencies`
  (`npm i -D nodemon cross-env wait-on`).
- **Add `"workspaces": ["daemon"]` to root `package.json`** (closes
  round-2 devx P0-1).
- Create `nodemon.daemon.json` (config in §3.7.3 above).
- Create `scripts/wait-daemon.cjs` (resolves cross-platform lockfile path
  + invokes `wait-on file:`).
- Create `scripts/setup.cjs` (one-stop install + native rebuild) —
  closes round-2 devx P0-4.
- Edit root `package.json` `scripts`:
  - Replace `dev` to add `daemon` lane (§3.7.2).
  - Add `dev:daemon`, prepend `cross-env CCSM_DAEMON_DEV=1` to `dev:app`,
    use `node scripts/wait-daemon.cjs` for the daemon-ready probe (NOT
    the no-op `tcp:127.0.0.1:0`).
  - Add `setup` script.
- README + CONTRIBUTING note covering toolchain prerequisites table
  from §3.7.2.c (folds in devx MUST-FIX 5 + round-2 P0-4).
- Add VS Code TS Project References to `tsconfig.json` (`references: [{ path: "daemon" }]`)
  + `composite: true` to `daemon/tsconfig.json` (closes round-2 devx
  S-3 — small but high payoff).
- Estimate breakdown: nodemon config + script wiring 2 h, wait-daemon
  + setup scripts 1 h, workspaces wiring 0.5 h, README + tsconfig refs 1.5 h.

### Task 7 (Connect client + handshake) — **+9 h** (was +7 h)

- New file: `electron/daemonClient/reconnectQueue.ts` (~120 LOC, FIFO
  queue, dev/prod cap split, exponential backoff scheduler).
- New file: `electron/daemonClient/streamHandleTable.ts` (~80 LOC,
  iterates handles for `.cancel()` on reconnect, clears client-side
  heartbeat timers).
- Modify `electron/daemonClient/connectClient.ts`: wrap `rpcCall` so it
  routes through the queue when the underlying socket is down; expose
  `subscribe(descriptor)` returning an unsub fn that also removes from
  the resubscription map; include `bootNonce` capture per §3.7.5.
- Modify `electron/daemonClient/spawnOrAttach.ts`: in dev mode
  (`CCSM_DAEMON_DEV=1`), **skip** the `spawnIfMissing` branch — nodemon
  owns the daemon lifecycle; Electron only attaches with retry. Also
  ensure dev mode does NOT call into frag-11's pkg-binary path resolver
  at all (closes round-2 devx P0-3 spawnOrAttach side).
- Modify Task 7 step 4 spawn: `stdio: process.env.CCSM_DAEMON_DEV ?
  "inherit" : "ignore"` and `detached: !process.env.CCSM_DAEMON_DEV`.
- New tests: `connectClient.reconnect.test.ts` (+2 h),
  `connectClient.resubscribe.test.ts` (+1 h, includes bootNonce + stale
  handle cleanup).
- New e2e phase: `harness-agent.daemonReconnect` (+1 h folded into
  existing fixture, NOT a standalone probe — closes round-2 devx P1-7;
  platform-aware kill target per round-3 devx P1-5).
- Pre-mount loader: PUNTED to frag-6-7 §6.8 (was §3.7.8.d in r2; surface
  registry collapse moves the trigger there).
- Estimate breakdown: queue + backoff impl 2 h, subscribe map +
  bootNonce 1.5 h, streamHandleTable 1 h, spawnOrAttach dev-mode
  branch 1 h, tests 3 h, harness-agent phase 0.5 h. (Pre-mount loader
  hour moved to frag-6-7's plan delta.)

### Task 11 (PTY service lift) — **+1 h** (resubscribe contract)

- Confirm PTY RPC contract accepts `fromSeq` and emits `gap: true` when
  asked for an evicted sequence (already mandated by §3.5.1 fragment;
  this is a cross-fragment sanity check, not new work).
- Confirm `bootNonce` is included in the subscribe response envelope
  (declared by frag-6-7 §6.5; camelCase locked round-3).

### Task 13 (notify service lift) — **+1 h** (resubscribe contract)

- Same `fromSeq` / `gap` / `bootNonce` semantics as Task 11.

### Task 21 (tray) — **+0.5 h** (Quit semantics only)

- **Tray "Quit" handler** (round-3 devx P1-1): wire `app.quit()` (NOT
  `win.close()`) so the working tray-menu Quit button actually exits
  the app even when in close-to-tray hidden state. (The former r6
  rationale referenced a `reconnectExhausted` modal Quit button; that
  modal was cut by §6.8 r7. The tray-menu Quit is now the only
  Quit affordance.)
- [manager r7 lock: cut as polish — N2# from r6 feature-parity. Win-only
  "Tail daemon log in new terminal" tray entry deleted; v0.3 ships
  working's `[Show CCSM | Quit]` tray menu unchanged. Log path lives in
  release notes only.]
- [manager r7 lock: cut as polish — N4# from r6 feature-parity. The
  close-to-tray onboarding hint surface AND the
  `close_to_tray_shown_at` SQLite key are deleted entirely. Working's
  existing `closeBehaviorOptions.ask` first-close prompt already covers
  the discoverability concern; no parallel onboarding moment. Task 21
  no longer wires any close-hint check beyond the existing close-prompt
  preserved from working.]

### New sub-task under Task 7: renderer surface registry bridge — **+1 h** (was +2 h)

- New file: `src/app-effects/useDaemonReconnectBridge.ts` (mirrors
  `useUpdateDownloadedBridge.ts` and `usePersistErrorBridge.ts`;
  publishes into the canonical surface registry via §6.8's
  `useDaemonHealthBridge` rather than owning a separate
  `useSurfaceRegistry.ts`). Subscribes to reconnect events from
  `connectClient`, applies the 250 ms hold-off, dispatches the trimmed
  surface set per the §6.8 r7 cut: `daemon.unreachable` (banner, covers
  reconnect-attempt-failed + supervisor-down) / `daemon.reconnected`
  (toast, debounced 5s) / `daemon.crashLoop` (modal). Polish surfaces
  cut by §6.8 r7 (`daemon.queueOverflow`, `daemon.bridgeTimeoutSpike`,
  `daemon.streamGap`, `daemon.devBuildError`,
  `daemon.healthDegraded`, `daemon.reconnectExhausted`) are LOG ONLY —
  no IPC publish.
- The `useSurfaceRegistry.ts` central bus that the r2 plan delta
  proposed is **NOT** built here — it lives in frag-6-7 §6.8 plan delta
  (round-3 manager arch decision #1).
- New i18n keys (dot+camelCase per round-3 lock #5) in
  `src/i18n/locales/en.ts` and `src/i18n/locales/zh.ts` — only the
  three keys the bridge still dispatches; the canonical copy table
  lives in §6.8 / §6.1.1.
- Wire bridge into `src/App.tsx` next to existing `*Bridge` calls.
- Estimate breakdown: bridge 0.75 h, i18n + wiring 0.25 h. (1 h saved
  vs r6's +2 h by trimming the dispatched surface set per §6.8 r7
  feature-parity cuts.)
- [manager r7 lock: surfaces trimmed per N6# from r6 feature-parity —
  daemon-split brings new failure modes the user MUST see (unreachable,
  crashLoop, reconnected confirmation), but degraded-but-functional
  states (queueOverflow, bridgeTimeoutSpike, streamGap, devBuildError,
  healthDegraded, reconnectExhausted) are not user-must-see and were
  log-only in working.]

### Task 25 (dogfood acceptance) — **+0.5 h** (production log access — docs only)

- Daemon log path documented in release notes + About dialog so users
  can locate `<dataRoot>/logs/daemon.log` for support diagnostics.
- Acceptance: pino-roll rotation cycle works on Win 11 (rotated file
  written) AND on macOS / Linux (symlink updated). Path is OS-native
  data root per round-3 lock #3 (`<dataRoot>/logs/daemon.log` — see
  frag-11 §11.6 for the canonical dataRoot paths, NOT `~/.ccsm/`).
- [manager r7 lock: cut as polish — N2# + N3# from r6 feature-parity.
  Tray "Open daemon log" entry + Win "Tail daemon log in new terminal"
  entry DELETED entirely; v0.3 is refactor scope, no new tray menu
  items. `pino-roll` `symlink: true` (frag-6-7 §6.6) still required for
  POSIX `tail -F` from a user terminal; Win users open the dated
  rotated file directly via Explorer. The Win symlink-handle caveat is
  noted in release notes only.]

### Total v0.3 estimate impact

**+18 h** (Task 1 +5, Task 7 +9, Task 11 +1, Task 13 +1, Task 21 +0.5,
new surface-bridge sub-task +1, Task 25 +0.5). Down from r6's +21 h:
r7 polish cuts removed the Win tail-log + Open daemon log tray entries
(-1.5 h on Task 25), trimmed Task 21's tray work (-0.5 h, no
close-to-tray onboarding), and shrank the surface-bridge sub-task
(-1 h, fewer i18n keys to wire — see frag-6-7 §6.8 row count cut).
Plus closes the round-3 P0-UX-A surface-registry-duplicate bug.

---

## Cross-frag rationale

§3.7 owns **devx mechanics** (nodemon topology, reconnect queue,
resubscribe, dev-mode supervisor disablement). The user-visible surface
registry is **NO LONGER OWNED HERE** — round-3 manager arch decision #1
collapses it into frag-6-7 §6.8 as the canonical source. §3.7's
reconnect bridge publishes into §6.8 rather than owning a parallel
vocabulary.

All P0 + P1 items from round-2 + round-3 reports under
`~/spike-reports/v03-r{2,3}-*.md` that touch §3.7's wire surface have
been folded in; items that belong on a sibling fragment are explicitly
**punted** below with a one-line contract for the receiving fixer.

**Owned by §3.7 (this fragment, applied above):**

- devx P0-1 — Workspaces declaration in root `package.json` — Task 1.
- devx P0-2 — `wait-on tcp:127.0.0.1:0` no-op replaced with
  `scripts/wait-daemon.cjs` + `wait-on file:` against OS-native data
  root. §3.7.2 + Task 1.
- devx P0-3 (spawnOrAttach side) — dev mode skips pkg-binary path.
  §3.7.2.b + Task 7. **frag-11 still owns** the `devTarget()` fence.
- devx P0-4 — Toolchain prerequisites + `npm run setup`. §3.7.2.c +
  Task 1.
- devx P0-5 (tray "Open daemon log" + Win tail entry) — Task 25 plan
  delta. **frag-6-7 still owns** the `pino-roll symlink: true` config
  itself (round-3 devx CF-1 / resource X2: not landed in r2).
- devx P1-3 — Dev-build-error surface published into §6.8 by §3.7
  bridge.
- devx P1-6 — Stream handle `.cancel()` before resubscribe — §3.7.5
  step 1 + new `streamHandleTable.ts`.
- devx P1-7 — E2E folded into `harness-agent.daemonReconnect` phase.
- reliability P1-R1 — Dev queue cap = 1000 — §3.7.4.
- resource P0-1 — Reconnect-queue does NOT replay through queue;
  §3.7.4.a. **frag-3.5.1 §3.5.1.5 still owns** the carve-out sentence.
- ux P1-UX-1 — Reconnect retries forever → promote to §6.8
  `daemon.unreachable` red banner once supervisor miss threshold is
  passed (the former r6 N=15 `reconnectExhausted` modal was folded
  into `daemon.unreachable` per §6.8 r7 trim). §3.7.4 + cross-ref §6.8.
- ux P1-UX-4 — Reconnect surface vs supervisor banner mutual
  exclusion — owned by §6.8's stacking rule, this fragment publishes
  conformantly.
- fwdcompat P1-1 — `bootNonce` (camelCase, locked round-3) in subscribe
  response. §3.7.5 step 3.
- fwdcompat (canonical stream-RPC contract owner) — §3.7.5 references
  frag-3.4.1 §3.4.1.b as canonical instead of re-declaring.
- **r3 ux P0-UX-A** — §3.7.8 deleted, replaced with cross-ref to
  frag-6-7 §6.8. Closes the two-competing-registries bug.
- **r3 ux/resource CC-1/X4** — close-to-tray SQLite key dropped here;
  §6.8 owns `close_to_tray_shown_at` (timestamp, manager arch
  decision #2).
- **r3 ux CC-3** — i18n keys locked dot+camelCase in the new §3.7.8
  cross-ref paragraph + plan delta.
- **r3 ux CC-4 / fwdcompat #2** — `BridgeTimeoutError` never
  user-surfaced per-call; surfacing absorbed into §6.8 spike + modal
  slots.
- **r3 obs P1-2** — Reconnect emitter cross-refs frag-6-7 §6.6.2
  canonical log line names (`daemon_socket_closed`,
  `daemon_reconnect_attempt`, `daemon_reconnect_success`,
  `daemon_queue_overflow`, `stream_resubscribe`). §3.7.4 toast UX
  paragraph.
- **r3 reliability CF-3** — §3.7.6.a clarified: supervisor restart loop
  off in dev, transport + healthz polling stay for status badge.
- **r3 devx P1-1** — Tray "Quit" handler calls `app.quit()` not
  `win.close()`. Task 21 plan delta.
- **r3 devx P1-2** — In-flight chunk dedup across teardown documented
  in §3.7.5 step 3 (renderer trusts `seq` only within one
  `(sid, bootNonce)` tuple).
- **r3 devx P1-3** — `npm rebuild --prefix daemon` → `npm -w
  @ccsm/daemon rebuild`. §3.7.2.c.
- **r3 devx P1-4** — `Get-Content -Wait` symlink-follow caveat: POSIX-
  only fix; Win adds tray "Tail daemon log in new terminal" entry.
  §3.7.2.d + Task 25.
- **r3 devx P1-5** — E2E `pkill` target made platform-aware for
  prod-installed daemon. §3.7.7.

**Punted to other fragments (one-line contract for the receiving
fixer):**

- **frag-11 fixer** — §11.2 must remove or fence the `devTarget()`
  branch behind `!process.env.CCSM_DAEMON_DEV` so prod path doesn't
  read as authoritative for dev. (devx P1-4 + remainder of P0-3;
  round-3 devx CF-2 not landed in r2.)
- **frag-3.5.1 fixer** — §3.5.1.5 must add: "initial replay burst on
  resubscribe is NOT counted toward the 1 MB per-subscriber drop-
  slowest watermark" (resource P0-1 resolution b). §3.5.1.3 must add:
  "BridgeTimeoutError is logged with `DEADLINE_EXCEEDED` but NEVER
  surfaced to the user; surfacing is owned by frag-6-7 §6.8's single
  `daemon.unreachable` banner slot per the §6.8 r7 trim (separate spike
  + reconnectExhausted slots are cut)" (round-3 ux CC-4 / devx CF-3
  not landed in r2).
- **frag-6-7 fixer (highest-priority pickup queue):**
  - §6.6 pino-roll config must add `symlink: true` to BOTH daemon and
    electron blocks (round-3 resource X2 / devx CF-1 not landed in r2).
  - §6.8 must absorb the **dev-only `daemon.devBuildError`** surface at
    priority 50 (only surface that fires in dev but not prod; all other
    former-§3.7.8 rows already have §6.8 equivalents). [manager r11 lock:
    PUNT obsolete — §6.8 r7 trim explicitly cut `daemon.devBuildError`;
    this slot is permanently LOG ONLY per §3.7.5 r7 lock. (historical;
    no longer relevant)]
  - §6.8 must absorb the **pre-mount loader** trigger (was §3.7.8.d in
    r2; r3 surface-registry collapse moves it here). 1 h estimate
    transferred from §3.7's plan delta.
  - §6.8 must lock `close_to_tray_shown_at` (timestamp) as the
    canonical SQLite key (round-3 manager arch decision #2 + ux CC-1).
- **Task 21 (tray) owner** — wire `close_to_tray_shown_at` check before
  `win.hide()`; emit the §6.8 onboarding-hint surface on the first
  close (round-3 manager arch decision #2). Also wire `app.quit()`
  semantics for the modal "Quit" button (round-3 devx P1-1).

**Not addressed (out of §3.7 scope, flagged for completeness):**

- devx P1-1 r2 (Task 5 21h hot-file collision on `connectAdapter.ts`)
  — plan-organisation concern. **Punt to manager**.
- devx P1-5 r2 (native helper compile on every checkout) — partial
  mitigation via §3.7.2.c. Full fix owned by frag-3.5.1 §3.5.1.1.
- ux P0-UX-3 (cold-start no-bak modal full copy) — full ownership lives
  with frag-6-7 §6.1.1 copy table.
- All SHOULD/nits not adjacent to a P0/P1 intentionally not edited per
  round-3 fixer scope.

---

## 3-line summary

Round-3 collapses §3.7.8 into a one-paragraph cross-ref to frag-6-7 §6.8
(canonical surface registry, manager arch decision #1), drops the
duplicate close-to-tray SQLite key, and locks `bootNonce` to camelCase +
i18n keys to dot+camelCase across the bundle. §3.7.6.a is clarified
(supervisor restart loop off in dev, but transport + `/healthz` polling
stay for status badge). Five round-3 P1 nits folded in: tray "Quit"
calls `app.quit()`, in-flight chunks dedup by `(sid, bootNonce)` tuple,
`npm -w @ccsm/daemon rebuild` syntax, Win `Get-Content -Wait` symlink-
follow caveat (POSIX-only fix + new tray "Tail in new terminal" entry),
and platform-aware e2e kill target for prod-installed daemon.
