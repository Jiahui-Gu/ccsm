# Track C phase-1 — Unify the PTY resize clamp

**Date:** 2026-05-30
**Status:** Design — awaiting user review before implementation
**Scope:** One focused change to the `pty:resize` validation path. No new
features, no transport-protocol changes.

## Problem

A PTY resize can enter the host from two transports, and a third layer does
the actual work. All three validate `cols`/`rows` differently:

| Layer | File / line | Floor | Ceiling | NaN/Inf guard |
|-------|-------------|-------|---------|----------------|
| Desktop IPC | `ptyHost/ipcRegistrar.ts:219-221` | `<1` → reject | `>1000` → reject | yes (`Number.isFinite`) |
| Remote WS | `remote/remoteMessages.ts:91-94` | `Math.max(2, …)` → clamp up | **none** | `Number.isInteger` pre-check |
| Lifecycle (shared sink) | `ptyHost/lifecycle.ts:151` | `<2` → reject | **none** | none |

Both transports funnel into `lifecycle.resize` via
`resizePtySession` → `index.ts:82` → `lifecycle.resize`. So the lifecycle is
the real convergence point, yet it carries the weakest guard (`<2` reject, no
ceiling, no NaN handling). The two transports each re-implement a *different*
partial guard in front of it.

Concrete divergence a user could hit:

- A remote client that requests `cols = 5000` is **honored** (no ceiling on the
  remote path, no ceiling in lifecycle) — node-pty allocates a 5000-column
  terminal. The desktop path would have rejected the same request.
- A remote client that requests `cols = 1` is **clamped to 2** (terminal keeps
  working). The desktop path rejects `<1` but *passes* `cols = 1` down to
  lifecycle, where the `<2` floor then rejects it — so desktop `cols = 1`
  silently no-ops while remote `cols = 1` becomes a working `cols = 2`.

The behavior of an identical resize therefore depends on which transport sent
it. That is the drift this change removes.

## Goal

One validator, owned by the convergence point (`lifecycle.resize`), so every
caller — present and future — gets identical floor, ceiling, and NaN/Inf
handling. The transports stop clamping and become pure translate-and-forward.
This is the Track C "transport is dumb" principle applied to the smallest
real slice.

## Non-goals

- No change to the wire protocol or the preload bridge surface.
- No `window.ccsm` transport abstraction (that is the deferred Track C phase-2).
- No change to spawn-time sizing (`DEFAULT_COLS/ROWS` path is untouched).
- No disconnect buffering, no resize debouncing (YAGNI).

## Chosen semantics: floor-clamp / ceiling-reject

When a resize is out of range:

- **Too small** (`< MIN_PTY_DIM`) → **clamp up** to `MIN_PTY_DIM`. A 0/1-column
  PTY breaks CLI line wrapping; silently bumping to the floor keeps the
  terminal usable rather than freezing it at its old size. (This is what the
  remote path already does and is the correct behavior.)
- **Too large** (`> MAX_PTY_DIM`) → **reject the whole resize** (no-op, keep
  old size). The ceiling exists only to bound a hostile `2^31 × 2^31` request;
  a real client never exceeds ~600. We must not *honor* a pathological size
  even clamped — rejecting leaves the PTY at its last sane size.
- **NaN / Infinity / non-integer** → **reject**. Never reaches node-pty.

This matches the desktop-proven path (the one real users drive daily): desktop
already rejects `>1000` and guards NaN/Inf; the only desktop change is that its
`<1`/lifecycle-`<2` reject becomes a clamp-to-2, which is strictly friendlier
(a slightly-too-small viewport resize now succeeds at 2 instead of no-opping).

### Why clamp the floor but reject the ceiling (not symmetric)?

A too-small value is almost always a benign transient (a viewport measured
mid-layout, a 1px pane). Clamping keeps the terminal live. A too-large value is
never benign at that magnitude — it is either a bug or an attack, and the right
response is to refuse it, not to silently substitute 1000 (which would make the
client believe it has N columns when it has 1000). Asymmetry is intentional and
documented at the validator.

## Architecture

Single validator inside `lifecycle.resize`, fed by two shared constants.

```
remote/remoteMessages.ts ─┐
                          ├─→ resizePtySession(sid, cols, rows) ─→ index.ts:82
ptyHost/ipcRegistrar.ts ──┘                                         │
                                                                    ▼
                                              lifecycle.resize(sessions, sid, cols, rows)
                                              ── normalizeResizeDims(cols, rows) ──┐
                                                 • not finite int → null (reject)  │
                                                 • > MAX_PTY_DIM   → null (reject)  │
                                                 • < MIN_PTY_DIM   → MIN_PTY_DIM    │
                                                 else pass-through                 │
                                              if null → return (no-op)             │
                                              else pty.resize + headless.resize ◀──┘
```

### Components

1. **Constants** — `entryFactory.ts` (already owns `DEFAULT_COLS/ROWS`):
   ```ts
   export const MIN_PTY_DIM = 2;
   export const MAX_PTY_DIM = 1000;
   ```

2. **`normalizeResizeDims(cols, rows)`** — a pure exported helper in
   `lifecycle.ts`:
   ```ts
   export function normalizeResizeDims(
     cols: number,
     rows: number,
   ): { cols: number; rows: number } | null {
     const norm = (n: number): number | null => {
       if (!Number.isFinite(n)) return null;
       if (n > MAX_PTY_DIM) return null;     // ceiling: reject
       return Math.max(MIN_PTY_DIM, Math.floor(n)); // floor: clamp
     };
     const c = norm(cols);
     const r = norm(rows);
     if (c === null || r === null) return null;
     return { cols: c, rows: r };
   }
   ```
   Pure + exported so the policy is unit-testable without a live PTY.

3. **`lifecycle.resize`** calls the helper, replacing the `<2` line:
   ```ts
   const dims = normalizeResizeDims(cols, rows);
   if (!dims) return;
   entry.pty.resize(dims.cols, dims.rows);
   entry.headless.resize(dims.cols, dims.rows);
   entry.cols = dims.cols;
   entry.rows = dims.rows;
   ```

4. **Transports lose their clamps** (become pure forwarders):
   - `remoteMessages.ts`: drop `Math.max(2, …)`; keep the `Number.isInteger`
     type-shape check that produces the `invalid_resize` wire error (that is
     protocol input validation — distinct from dimension policy — and the
     client contract depends on the error reply). Forward the raw integers.
   - `ipcRegistrar.ts`: drop the `isFinite` + `<1/>1000` block. The lifecycle
     validator now owns all of it. (Defense-in-depth note below.)

### Defense-in-depth consideration

`ipcRegistrar.ts` currently guards NaN/Inf at the IPC boundary as a
"never trust the renderer" measure. Moving the guard into lifecycle does not
weaken this: lifecycle now rejects NaN/Inf itself, and it is the *only* path to
node-pty. There is no longer a way to reach `pty.resize` without passing the
validator, so the boundary guard is redundant, not load-bearing. Removing it
avoids the exact drift this spec exists to kill (two guards that disagree).

## Data flow / error handling

- **Desktop**: renderer `pty:resize` → ipcRegistrar forwards raw → lifecycle
  validates. Out-of-range now silently no-ops (unchanged user-visible outcome
  for `>1000`; `cols=1` now succeeds at 2 instead of no-op).
- **Remote**: client `session.resize` → `Number.isInteger` shape check (wire
  error on non-int, unchanged) → forwards raw → lifecycle validates. A
  `cols=5000` request now **no-ops** instead of allocating a 5000-col PTY
  (behavior change, and the intended fix).
- No new error surfaces. Out-of-range is silent no-op at lifecycle (matches
  desktop's existing contract). The remote wire `invalid_resize` error is
  preserved for *malformed* (non-integer) input only.

## Testing

Unit (vitest, no live PTY needed):

1. `normalizeResizeDims` table test:
   - `(120, 30)` → `{120, 30}` (pass-through)
   - `(1, 1)` → `{2, 2}` (floor clamp)
   - `(0, 30)` → `{2, 30}` (floor clamp one axis)
   - `(1001, 30)` → `null` (ceiling reject)
   - `(120, 5000)` → `null` (ceiling reject one axis)
   - `(NaN, 30)` / `(Infinity, 30)` / `(120, -Infinity)` → `null`
   - `(120.7, 30.2)` → `{120, 30}` (floor to int)
2. `lifecycle.resize` integration with a fake entry: asserts `pty.resize` is
   called with clamped dims for a small request, and **not called** for an
   out-of-range request (old size preserved).
3. Regression: existing `ipcRegistrar.test.ts` resize cases updated — `>1000`
   still no-ops (now via lifecycle), `cols=1` now resizes to 2 (was no-op).
   This is the one intentional desktop behavior change; the test documents it.
4. Remote: existing `mobileRemoteServer.test.ts` resize path — a `cols=5000`
   resize no longer changes `getPtySession().cols` (was previously honored).

All existing resize tests must still pass after the transport clamps are
removed (they now exercise the lifecycle validator transitively).

## Verification

- Local pre-push gate: `npm run typecheck && npm run lint && npm test` green.
- Headless harness: not required — this is pure host-side logic with no
  rendered surface. The unit tests above are the strong evidence (they exercise
  the real validator at the real convergence point). No real-device step needed.
- The one user-visible desktop delta (`cols=1` → resizes to 2 instead of
  no-op) is benign and covered by an updated regression test; flag it in the PR
  description.

## Risk

Low. The change consolidates three guards into one at the point they all
already funnel through. The only behavior changes are (a) remote oversize
requests stop being honored — the bug being fixed — and (b) desktop `cols=1`
now succeeds at 2. Both are improvements and both are pinned by tests.
