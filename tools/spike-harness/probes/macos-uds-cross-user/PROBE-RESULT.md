# T9.2 spike — macOS UDS cross-user reachability without Full Disk Access

**Status:** smoke harness landed; live darwin matrix capture deferred to a
self-hosted macOS runner with a pre-provisioned secondary local user
(see "Follow-ups" below). Authored on Windows (`MINGW64_NT-10.0-26200`);
on non-darwin hosts the harness short-circuits (`run.sh` exits 2, both
`server.mjs` and `client.mjs` exit 2 on `win32`). The decision matrix in
this document is the **spec-derived** verdict that the live runner is
expected to confirm; any divergence the runner observes overrides this
file and must trigger a follow-up before listener-A wiring proceeds on
darwin.

Spec anchor: ch14 §1.2 phase 0.5 — "macOS UDS cross-user reachability
without Full Disk Access; must resolve before listener-A wiring on
macOS." Listener-A is defined in
`docs/superpowers/specs/2026-05-02-final-architecture.md` line 87 as the
"peer-cred-trusted local socket (UDS / named pipe). JWT bypass.
Same-UID processes only." The cross-user probe quantifies what happens
when that same-UID assumption is violated by a process running under a
different local account.

## Files

- `server.mjs` — UDS line-echo server (`net.createServer`), `chmod 0666`
  on bind so any cross-user denial is attributable to TCC/FDA rather
  than POSIX permission bits. SIGTERM-safe socket unlink. Stdlib only.
- `client.mjs` — single-shot `connect()` probe, classifies the outcome
  as `OK`/`EACCES`/`EPERM`/`ENOENT`/`ECONNREFUSED`/`ETIMEDOUT`/`OTHER`
  and emits one JSON summary line. Designed to be invoked under
  `sudo -n -u <user>` for the cross-user leg.
- `run.sh` — iterates a 6-path candidate matrix, starts the server as
  the invoking user, runs the client both same-user and (if
  `SPIKE_SECONDARY_USER` is set) cross-user, then writes
  `macos-uds-cross-user-matrix.ndjson` + `macos-uds-cross-user-summary.json`
  to `$SPIKE_LOG_DIR` (default `/tmp`).

## How to run on a real darwin host

```bash
# Required: a second local user whose login shell can be sudo'd into
# without a password prompt. Suggested: `dscl . -create /Users/ccsmprobe`
# + a NOPASSWD sudoers entry scoped to /usr/local/bin/node.
SPIKE_SECONDARY_USER=ccsmprobe \
  bash tools/spike-harness/probes/macos-uds-cross-user/run.sh
```

Then re-render the "Live capture" section below from
`/tmp/macos-uds-cross-user-summary.json`.

## Verdict legend

The driver assigns one of four verdicts per (path, leg) row:

| Verdict | Meaning | Implication for listener-A |
| --- | --- | --- |
| `FDA-FREE` | `connect()` succeeds without any TCC grant. | Path is safe for cross-user listener-A *if* peer-cred check rejects the connection at the application layer (the kernel already lets the connect through, so application-level UID enforcement is mandatory). |
| `FDA-REQUIRED` | Path lives under a TCC-protected scope (`~/Library/...`, `~/Documents`, etc.) and the cross-user `connect()` returns `EPERM` / `EACCES` / `ENOENT`. | Cross-user reach is *blocked by the OS by default*, but a user who has granted FDA to the connecting binary (Terminal, an IDE, another Electron app) bypasses the block. Treat as defence-in-depth, never as the primary boundary. |
| `UNREACHABLE` | Bind failed, or peer connect timed out / hit an unexpected errno. | Don't pick this path. |
| `SKIPPED` | `SPIKE_SECONDARY_USER` was unset, so the cross-user leg wasn't run. | Re-run on a real darwin host. |

## Decision matrix (spec-derived; confirm with live capture)

Same-user leg is expected to be `OK`/`FDA-FREE` for every path the
primary user can bind. Cross-user verdicts below assume the connecting
user has **no** FDA grant, which is the worst-case for the daemon
(any other state is strictly more permissive).

| Bind path | tccProtected | Cross-user verdict (no FDA) | Cross-user with FDA on connector | Recommended for listener-A? |
| --- | :---: | --- | --- | --- |
| `/tmp/<sock>` | no | `FDA-FREE` (kernel allows; only POSIX perms gate) | same | candidate, but `/tmp` is world-writable and the socket can be `unlink()`'d by anyone; reject |
| `/private/tmp/<sock>` | no | identical to `/tmp/<sock>` (alias) | same | reject for the same reason |
| `/Users/Shared/<sock>` | no | `FDA-FREE` | same | candidate; `/Users/Shared` is the documented Apple-blessed cross-user spot, mode `1777`, not TCC-fenced. Pair with `chmod 0600` + peer-cred to keep it same-UID-only |
| `~/Library/Caches/<sock>` | yes | `FDA-REQUIRED` (TCC denies cross-user `connect()`) | `OK` (FDA bypasses TCC) | **recommended** for listener-A: same-UID processes connect freely, cross-user processes are kernel-blocked unless the *user* has explicitly granted FDA, which is a deliberate choice. Defence-in-depth on top of peer-cred, not a replacement for it |
| `~/Library/Application Support/<sock>` | yes | `FDA-REQUIRED` | `OK` | acceptable; `~/Library/Caches` preferred because Caches is documented as expendable (matches v0.3 "daemon socket can be re-bound on restart") |
| `~/Documents/<sock>` | yes | `FDA-REQUIRED` (Documents is a TCC-fenced "user data" location) | `OK` | reject — semantically wrong (sockets are not user documents) and triggers a TCC prompt cascade for any app that opens the file picker there |

## Recommendation feeding listener-A wiring

1. **Bind path on darwin: `~/Library/Caches/ccsm/daemon.sock`** (resolved
   from `$HOME` at daemon start, `mkdir -p` the parent with `0700`,
   `chmod 0600` on the socket). This delivers two layers:
   - POSIX: `0600` rejects every non-`euid==daemon-uid` connect with
     `EACCES` at the kernel.
   - TCC: even if the user widens permissions later, the parent path
     sits inside `~/Library`, so a cross-user connector still needs FDA
     to reach it. FDA is a deliberate user grant; we don't have to
     defend against the user explicitly opting in.
2. **Application-layer peer-cred check is still mandatory.** TCC and
   POSIX perms are defence-in-depth. The daemon must call
   `getsockopt(LOCAL_PEERCRED, ...)` on every accepted UDS connection
   and drop anything whose `uid` ≠ daemon's `euid`. The
   `tools/spike-harness/connect-and-peercred.sh` helper (T9.1's
   contract) is the reference implementation.
3. **Do NOT bind under `/tmp`, `/private/tmp`, or `/Users/Shared`** for
   listener-A. Even with `0600` they sit outside any TCC fence; a stale
   socket file from a prior run can be `unlink()`'d by any local user,
   creating a reliable bind-squat race window during daemon restart.
   `~/Library/Caches` closes that race because the parent itself is
   `0700`-by-default and TCC-fenced.
4. **Do NOT rely on FDA as the primary boundary.** A user with FDA on
   their daily-driver Terminal (very common on developer machines)
   would bypass the TCC layer; the POSIX `0600` + peer-cred check is
   what actually keeps cross-user processes out.

This pins the macOS half of the listener-A transport choice; the linux
counterpart (T9.4 `uds-h2c`) already locks `option A (h2c-over-UDS)` on
linux pending its own 1h soak.

## Live capture (TODO — populate from real darwin run)

Schema for the matrix file (one JSON object per line):

```json
{"path":"/tmp/ccsm-spike-…","leg":"same-user","tccProtected":false,
 "outcome":"OK","errno":null,"rttMs":1,"verdict":"FDA-FREE"}
```

Schema for the summary file:

```json
{ "rows": 12,
  "counts": { "FDA-FREE": N, "FDA-REQUIRED": M, "UNREACHABLE": K, "SKIPPED": 0 },
  "byPath": { "<path>": { "same-user": {...}, "cross-user": {...} } } }
```

Once captured, paste the `summary.json` `byPath` block here and confirm
the verdict column above row-for-row. Any `UNREACHABLE` or any
divergence from the spec-derived table escalates to manager before
listener-A wiring proceeds.

## Smoke verification on this host (win32)

```
$ bash tools/spike-harness/probes/macos-uds-cross-user/run.sh
macos-uds-cross-user: skipped on MINGW64_NT-10.0-26200 (UDS path semantics differ)
exit=2
```

`node --check` passes for both `.mjs` files; `bash -n run.sh` passes;
the harness directory is in eslint `ignores` per
`tools/spike-harness/README.md` Layer-1 constraint, so syntax-check is
the gate.

## Follow-ups

- T0.10 (#16): provision a secondary local user (`ccsmprobe`) on the
  self-hosted darwin runner with a `NOPASSWD` sudoers entry scoped to
  `node` only; wire `run.sh` into the runner with `SPIKE_SECONDARY_USER=
  ccsmprobe`. Capture `matrix.ndjson` + `summary.json` as build
  artifacts and update the "Live capture" section.
- Open question for T9.x (peer-cred): whether `getsockopt(LOCAL_PEERCRED)`
  on darwin returns the *connecting* process's `euid` or its `ruid`. The
  daemon must reject suid-promoted connectors; this affects the test
  matrix shape, not the bind-path choice. Track separately so this spike
  doesn't grow.
