# Audit Q2: `ccsm.loadState` removal across wave-2-A

- Spec: `docs/superpowers/specs/2026-05-06-v0.3-e2e-cutover-design.md` §1, §2.4
- Task: #596 (audit, READ-ONLY)
- Downstream: PR-1 (#602) consumes the recommended fix path
- Author: dev (pool-3, branch `task-596-audit-q2-git-blame-ccsm-loadstate-r`)
- Date: 2026-05-06

## TL;DR

`window.ccsm.loadState` is **not** missing because somebody forgot to put it
back in the preload layer. The renderer-side bridge surface was rewired in
wave-1-C from a `contextBridge` IPC call into a `fetch` shim
(`src/lib/window-ccsm-shim.ts`, PR #1098) and **the shim still exposes
`loadState`/`saveState`**. What is broken is a **URL contract drift between
the wave-1-C shim and the wave-2-A daemon HTTP router**:

| layer | name | path used |
|---|---|---|
| renderer shim (wave-1-C, PR #1098) | `loadState(key)` | `POST /api/loadState` |
| daemon router (wave-2-A,  PR #1104) | `safeLoadState(key)` | `POST /api/db/load` |
| renderer shim (wave-1-C, PR #1098) | `saveState(k,v)` | `POST /api/saveState` |
| daemon router (wave-2-A, PR #1104) | `safeSaveState(k,v)` | `POST /api/db/save` |

Result: every renderer call to `window.ccsm.loadState(key)` resolves to
`Error('HTTP 404 Not Found')` (or whatever the router emits for unknown
paths), surfacing as "persist load failed" in stores/persist.ts and
stores/drafts.ts. There is no surviving preload-side `loadState` function
anywhere — the v0.2 `ccsmCore.ts` bridge was deleted in wave-0-b
(commit `95d269e4`, PR #948) and wave-2-prep (commit `f0738856`, PR #1099)
restored only a stub skeleton + 4 `getDaemonPort/pickCwd/userHome/updates`
methods.

## Commit chain

### 1. `95d269e4` — wave-0-b: pure delete (PR #948, 2026-05-03)

Subject: `wave0b(#216): purge v0.2 ipc/preload/registrar — pure delete`

Deleted the entire `electron/preload/` tree (1 entry + 5 bridges), including
`electron/preload/bridges/ccsmCore.ts`, which previously held:

```ts
loadState: (key: string): Promise<string | null> =>
  ipcRenderer.invoke('db:load', key),
saveState: async (key: string, value: string): Promise<void> => {
  const result = await ipcRenderer.invoke('db:save', key, value);
  if (!result.ok) throw new Error(result.error);
},
```

Reason given in the commit body: clear the v0.2 IPC + contextBridge surface
so wave 0c (renderer cutover) and wave 1 (daemon wire-up) can land their
Connect-RPC replacement without colliding with stale IPC code. Acceptance
explicitly notes "Electron app NOT yet runnable" — the deletion was
intentional and the fix was deferred to subsequent waves.

### 2. `75881a92` — wave-1-C: renderer fetch shim (PR #1098, ~2026-05-04)

Subject: `v0.3(wave1-C): renderer fetch shim (window.ccsm compat over HTTP)`

Created `src/lib/window-ccsm-shim.ts` and `src/lib/daemon-client.ts`. The
shim re-implements the `window.ccsm` surface (incl. `loadState`/`saveState`)
on top of `fetch('http://127.0.0.1:<port>/api/<path>')`. Path mapping rule
(quoted from `daemon-client.ts` header):

> `window.ccsm.X(arg1, arg2, ...)` → `POST http://127.0.0.1:<port>/api/X`
> nested: `window.ccsm.window.minimize()` → `POST /api/window/minimize`
> nested: `window.ccsm.userCwds.get()`     → `POST /api/userCwds/get`

The shim therefore wires `loadState` to `m<string|null>('loadState')` →
`POST /api/loadState` (`window-ccsm-shim.ts:109`).

### 3. `f0738856` — wave-1-B: preload skeleton + business IPC delete (PR #1099)

Subject: `v0.3(wave1-B): electron spawns daemon + delete business ipc registers`

Restored `electron/preload/{index.ts, bridges/}` with a thin skeleton: only
`getDaemonPort`, `pickCwd`, `userHome`, and updater channels live in
`electron/preload/bridges/ccsmCore.ts`. The header explicitly states this is
the post-daemon shape:

> Everything else (db / sessions / pty / notify / session titles / i18n /
> import scan / userCwds / paths:exist / window controls) moved to the
> daemon's HTTP API. The renderer fetches `http://127.0.0.1:<port>/...`
> using the port returned by `getDaemonPort()`.

So `loadState`/`saveState` were **deliberately not re-exposed** on the
preload bridge — they are expected to live on the daemon HTTP side and be
called via the wave-1-C shim.

### 4. `4ff7c00d` — wave-2-A: physical move + data.ts API (PR #1104, 2026-05-06)

Subject: `v0.3(wave2-A): db + import + prefs + sessionTitles + sentry mv to daemon + data.ts API`

Physically moved `electron/db.ts`, `electron/db-validate.ts`,
`electron/sessionTitles/`, `electron/prefs/`, `electron/shared/`,
`electron/import-scanner.ts`, `electron/sentry/init.ts`, and
`electron/agent/read-default-model.ts` into `daemon/`. Added
`daemon/api/data.ts`, which registers 11 HTTP endpoints under
**`/api/{db,sessionTitles,app/userCwds,settings,import}/*`**:

```ts
router.addRoute('POST', '/api/db/load',  makeHandler(...));   // ← here
router.addRoute('POST', '/api/db/save',  makeHandler(...));   // ← here
router.addRoute('POST', '/api/sessionTitles/get', ...);
router.addRoute('POST', '/api/sessionTitles/listForProject', ...);
router.addRoute('POST', '/api/sessionTitles/flushPending', ...);
router.addRoute('POST', '/api/app/userCwds/get', ...);
router.addRoute('POST', '/api/app/userCwds/push', ...);
router.addRoute('POST', '/api/settings/defaultModel', ...);
router.addRoute('POST', '/api/import/scan', ...);
router.addRoute('POST', '/api/import/recentCwds', ...);
```

Wave-2-A did **not** touch `src/lib/window-ccsm-shim.ts` or
`src/lib/daemon-client.ts` (verified: `git show 4ff7c00d -- src/lib/window-ccsm-shim.ts`
returns no diff). The PR body explicitly says "Wire format `{args:[...]}` →
`{result}` | `{error}`, mirroring the legacy IPC handlers" — the wire
**envelope** matches, but the **route name** does not.

The cause is that wave-1-C's shim author (#1098) chose the convention
"flatten the JS method name to a URL segment" (so `loadState` → `/api/loadState`),
while wave-2-A's daemon author (#1104) grouped the HTTP routes by *legacy
IPC channel name* (`db:load` → `/api/db/load`, `db:save` → `/api/db/save`).
Both are reasonable schemes in isolation; they were never reconciled
because there is no machine-checked schema between the two trees, only
prose in the commit bodies.

Affected calls (every renderer caller of these methods, no exception):

- `src/stores/persist.ts` — calls `window.ccsm.loadState(key)` /
  `saveState(key, json)` for every Zustand-persisted slice.
- `src/stores/drafts.ts` — same, for the per-session draft text store.
- `src/components/settings/{NotificationsPane,UpdatesPane,AppearancePane}.tsx`
  — read settings via `loadState`.
- `src/lib/window-ccsm-shim.ts` — defines `loadState`/`saveState` (the shim
  itself is fine; only its target URL is wrong).

## Recommended fix path (input for PR-1 / Task #602)

The fix has to land in **the preload-side or shim-side** (renderer-process
wiring) because that is the side that owns the URL convention; the daemon
route names match the legacy IPC channels and other routes (`sessionTitles/`,
`app/userCwds/`, `settings/`, `import/`) follow the same group-by-channel
scheme. Renaming the daemon routes to match the shim convention would
break those other endpoints' callers as a knock-on. Recommended:

### Option A (recommended): point the shim at the existing daemon paths

Smallest diff, no daemon change, no breakage of other endpoints.

In `src/lib/window-ccsm-shim.ts`:

```ts
// before
loadState: m<string | null>('loadState'),
saveState: m<void>('saveState'),

// after
loadState: m<string | null>('db/load'),
saveState: m<void>('db/save'),
```

Same surgery for the other already-grouped daemon routes if they were
written the same way (the shim today calls `userCwds/get` / `userCwds/push`
but daemon registers `app/userCwds/get` / `app/userCwds/push`; PR-1 should
audit that pair too — cheap to grep). Specifically, walk the four route
groups in `data.ts` and grep `window-ccsm-shim.ts` for any non-matching
target; fix all in one PR so the fetch shim has a single coherent map.

The `saveState` daemon endpoint already returns `{result: {ok:true}|
{ok:false,error:string}}`, but the shim's type is `Promise<void>` and the
v0.2 preload contract was "throw on `{ok:false}`". The shim's generic
`m<void>('db/save')` resolves to `result` directly, dropping the discriminant
on the floor; PR-1 must add a custom unwrap for `saveState` that re-throws
on `{ok:false}`, otherwise persist failures degrade to silent data loss
(the same regression the original v0.2 bridge guarded against — see the
old `ccsmCore.ts` comment block).

### Option B (rejected): re-expose `loadState`/`saveState` on preload

Add back a `bridges/db.ts` that does `ipcRenderer.invoke('db:load', key)` →
register a real ipcMain handler in main.ts that proxies to the daemon.

Rejected because:

1. It re-introduces the v0.2 IPC layer that wave-0-b spent a whole PR
   deleting. The architectural direction (per spec §1 and the wave-0-b
   commit body) is "renderer talks to daemon via HTTP, preload only
   exposes things the daemon can't do": port discovery, OS dialogs, OS
   homedir, updater. `db:load` is exactly the kind of pure data call that
   belongs on the HTTP side.
2. Adds a 3-hop round-trip (renderer → preload → main → daemon HTTP →
   sqlite) when 1 hop already exists (renderer → daemon HTTP → sqlite).
3. The daemon endpoint already exists and is tested — the only fix needed
   is a 4-character path in the shim.

### Option C (rejected): rename daemon routes to match the shim

Drop the `db/`, `sessionTitles/`, `app/`, `import/`, `settings/` prefixes,
register routes as flat `/api/loadState`, `/api/saveState`, etc.

Rejected because:

1. Loses semantic grouping — a future `daemon/api/auth.ts` and
   `daemon/api/db.ts` could both want a `reset` op and would collide on
   `/api/reset`. The current scheme (`/api/<group>/<op>`) is forward-
   compatible with multi-module daemons.
2. Bigger diff (touches 11 routes + their tests) for the same outcome.
3. Conflicts with the "wire mirrors legacy IPC channel name" convention
   the wave-2-A PR body documented; future wave-2-B/C devs reading
   `data.ts` expect that scheme.

## Compatibility / type changes for PR-1

- `CcsmApi.saveState: (k, v) => Promise<void>` stays the same on the
  outside. The unwrap-and-throw lives inside the shim, not at call sites.
- No `global.d.ts` or ambient typing change needed (shim re-exports
  `CcsmApi` already; renderer call sites reference `window.ccsm.X` typed
  via `global.d.ts` which has not changed since v0.2).
- A tiny vitest UT in `src/lib/__tests__/window-ccsm-shim.test.ts` (or a
  new file) should mock `daemon-client.daemonInvoke` and assert that
  `loadState('foo')` calls it with path `'db/load'` and args `['foo']`.
  Same for `saveState` plus the unwrap-throw branch on `{ok:false}`. This
  is the regression test that prevents another shim/daemon drift from
  going unnoticed.

## Slice ownership

- **preload side (`electron/preload/bridges/ccsmCore.ts`)**: no change.
  Stays at the 4 OS-bound methods (`getDaemonPort`, `pickCwd`, `userHome`,
  updater channels). Confirmed correct per wave-1-B intent.
- **renderer shim (`src/lib/window-ccsm-shim.ts`)**: 4-line fix to
  `loadState`/`saveState` paths + saveState unwrap helper + the
  `userCwds/*` audit noted above.
- **daemon (`daemon/api/data.ts`)**: no change.

## File references (absolute paths)

- `C:/Users/jiahuigu/ccsm-worktrees/pool-3/electron/preload/index.ts`
- `C:/Users/jiahuigu/ccsm-worktrees/pool-3/electron/preload/bridges/ccsmCore.ts`
- `C:/Users/jiahuigu/ccsm-worktrees/pool-3/src/lib/window-ccsm-shim.ts`
- `C:/Users/jiahuigu/ccsm-worktrees/pool-3/src/lib/daemon-client.ts`
- `C:/Users/jiahuigu/ccsm-worktrees/pool-3/daemon/api/data.ts`
- `C:/Users/jiahuigu/ccsm-worktrees/pool-3/src/stores/persist.ts`
- `C:/Users/jiahuigu/ccsm-worktrees/pool-3/src/stores/drafts.ts`

## Commits referenced

- `95d269e4` — PR #948 — wave-0-b pure delete of v0.2 preload bridges
- `75881a92` — PR #1098 — wave-1-C renderer fetch shim
- `f0738856` — PR #1099 — wave-1-B preload skeleton restore
- `4ff7c00d` — PR #1104 — wave-2-A daemon physical move + `data.ts` HTTP
