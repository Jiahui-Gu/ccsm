# PR-4b: Desktop GitHub OAuth + safeStorage + Settings Entry — Design

> Vertical slice of the public-internet mobile-remote feature. Replaces PR-4's
> minimal env-var token provider (`readMobileRemoteLogin`) with a real GitHub
> OAuth login that the desktop drives, persists across restarts via Electron
> `safeStorage`, and surfaces through a Settings pane. The
> `mobileRemoteController` is **unchanged** — PR-4b only supplies a real
> `TokenProvider` and the UI/IPC/storage around it.

**Date:** 2026-05-31
**Base branch:** `feat/mobile-remote-web-exposure` (integration tip `ba707dc`, PR-4 merged)
**Authority specs:** `2026-05-30-mobile-remote-public-internet-detail.md` §4.1, §4.2, §9, §10
**Slicing decision:** memory `mobile-remote-pr4-slicing` — desktop OAuth UI is PR-4b, controller untouched, PR-5 = TURN + real-device 4G.

---

## 1. Goal

After PR-4b, a desktop user clicks **"Log in with GitHub"** in Settings → a popup
window completes the GitHub web flow via the existing Cloudflare Worker → the
desktop receives a short-lived session JWT + Durable Object URL, encrypts and
stores it via `safeStorage` → `startMobileRemote()` at `main.ts:302` now returns
a live peer instead of `null`. On restart, the stored session is reused (and
re-minted when expired, in PR-4b's silent-renewal limits). The GitHub access
token never reaches the desktop — the Worker holds the client secret and only
hands back a `userHash`-scoped session JWT (detail §4.1).

**Out of scope (deferred):** TURN credential fetch + real-device 4G reachability
= PR-5. Tray entry (we chose Settings; §10). Multi-account. Token *refresh* via a
long-lived GitHub refresh token — the Worker currently issues only a 15-min
session JWT and a 60-s auth_code; PR-4b persists the session JWT and **re-runs
the popup flow when it can't silently re-mint**. See §6 "Renewal honesty".

---

## 2. The two open decisions (resolved)

Both were left open by detail §10 and the PR-4b summary. Resolved autonomously
(night shift, both reversible, ≥90% confidence):

### 2.1 How the desktop receives the OAuth `authCode` → **popup `BrowserWindow` that intercepts `postMessage`**

The Worker's `GET /auth/github/start` 302-redirects to GitHub with a
**Worker-fixed `redirect_uri`** (`cfg.oauthRedirectUri` → the Worker's own
`/auth/github/callback`). The callback returns HTML whose script does:

```js
if (window.opener) window.opener.postMessage({ authCode }, "*");
window.close();
```

So the desktop does **not** need a custom `redirect_uri`, a localhost HTTP
server, or a `ccsm://` protocol registration. It opens
`https://ccsm-worker.jiahuigu.workers.dev/auth/github/start` in a dedicated
`BrowserWindow` whose **preload installs a faux `window.opener`** whose
`postMessage` forwards `{ authCode }` to the main process over IPC. The existing
Worker script runs unmodified and "forwards" to us.

**Why this over the alternatives**
- **Localhost redirect (`127.0.0.1:port`)**: standard native OAuth, but the
  Worker `redirect_uri` is fixed and would need a Worker change + a desktop HTTP
  listener (Windows firewall/AV friction). Rejected: more moving parts, Worker
  edit.
- **`ccsm://` custom protocol**: registration differs dev vs packaged and is a
  known Windows trap; largest change surface. Rejected.
- **Popup intercept**: zero Worker changes, no open port, no OS registration.
  Chosen.

**Faux-opener detail (the one subtlety).** A standalone `BrowserWindow` has
`window.opener === null`, so the Worker's `if (window.opener)` guard would skip
the `postMessage` and just `window.close()` — we'd get nothing. The popup
preload therefore defines a minimal `window.opener` **before** the Worker script
runs:

```ts
// electron/remote/oauthPopupPreload.ts (runs in the popup window)
const { ipcRenderer } = require('electron');
// The Worker callback script calls window.opener.postMessage({authCode}, "*").
// Standalone popups have no opener, so we supply one that forwards to main.
Object.defineProperty(window, 'opener', {
  value: { postMessage: (msg: unknown) => ipcRenderer.send('mobileRemote:oauthMessage', msg) },
  writable: false,
  configurable: false,
});
```

Preload runs before page scripts (Electron guarantee), and `contextIsolation`
in the popup is set **false** for this window only, so the page's `window.opener`
lookup hits our injected object. This popup loads only the trusted Worker origin
(asserted before accepting the message), never arbitrary content.

### 2.2 Where the login entry lives → **Settings pane**

A new **"Mobile remote"** pane in `SettingsDialog` (mirrors `UpdatesPane`).
Tray rejected: ccsm's tray has minimal interaction surface and would need new
scaffolding; Settings concentrates the change and matches §4.2's "桌面 UI 显示
'登录 GitHub 以启用手机远程'".

---

## 3. Components & files

```
electron/remote/
  oauthWindow.ts          NEW  opens popup BrowserWindow → resolves {authCode}
  oauthPopupPreload.ts    NEW  faux-opener preload (forwards postMessage→IPC)
  sessionStore.ts         NEW  safeStorage encrypt/decrypt of MobileRemoteLogin on disk
  oauthLogin.ts           NEW  orchestrates: popup → /auth/session → store
  oauthTokenProvider.ts   NEW  TokenProvider backed by sessionStore (replaces env reader at the call site)
  tokenProvider.ts        KEEP unchanged (env reader stays as a fallback/test seam)
  mobileRemoteController.ts  UNCHANGED

electron/ipc/
  mobileRemoteIpc.ts      NEW  ipcMain.handle for login / authState / logout; registers in main bootstrap

electron/shared/
  ipcChannels.ts          EDIT add MOBILE_REMOTE_CHANNELS

electron/preload/bridges/
  ccsmCore.ts             EDIT expose mobileRemoteLogin/AuthState/Logout + onMobileRemoteAuthState

electron/
  main.ts                 EDIT (1) inject oauthTokenProvider into startMobileRemote();
                                (2) allow restart of the peer when auth state flips

src/
  global.d.ts             EDIT add the three methods + push subscription + MobileRemoteAuthState type
  components/SettingsDialog.tsx     EDIT add 'mobile' tab
  components/settings/MobileRemotePane.tsx  NEW  login button + status + logout
  i18n/locales/{en,zh}    EDIT strings
```

### 3.1 `MobileRemoteLogin` (already exists, PR-4 `tokenProvider.ts`)

```ts
export type MobileRemoteLogin = { token: string; doUrl: string };
export type TokenProvider = () => MobileRemoteLogin | null;
```

PR-4b adds, in `sessionStore.ts`, a persisted superset that also tracks expiry so
the provider can null out a stale token:

```ts
type StoredSession = MobileRemoteLogin & { userHash: string; expiresAtMs: number };
```

### 3.2 `oauthWindow.ts`

```ts
export function runOauthPopup(opts: {
  workerOrigin: string;            // https://ccsm-worker.jiahuigu.workers.dev
  parent?: BrowserWindow;
  createWindow?: (o: BrowserWindowConstructorOptions) => BrowserWindow; // test seam
}): Promise<{ authCode: string }>;
```

Opens a 520×640 modal `BrowserWindow`, `webPreferences = { preload:
oauthPopupPreload, contextIsolation: false, nodeIntegration: false, sandbox:
false }`, loads `${workerOrigin}/auth/github/start`. Resolves on the first
`mobileRemote:oauthMessage` IPC carrying `{ authCode: string }` **from this
popup's `webContents` only** (sender check). Rejects on window close without a
code, or on a 120 s timeout. Always closes the popup in a `finally`.

### 3.3 `oauthLogin.ts`

```ts
export async function loginWithGithub(deps: {
  workerOrigin: string;
  runPopup: typeof runOauthPopup;
  fetchSession: (workerOrigin: string, authCode: string) => Promise<SessionResponse>;
  store: SessionStore;
}): Promise<MobileRemoteAuthState>;
```

`runPopup` → `{authCode}` → `POST ${workerOrigin}/auth/session` with body
`{ authCode }` → `{ token, userHash, doUrl, iceServers, expiresInSeconds }` →
`store.save({ token, doUrl, userHash, expiresAtMs: Date.now()+expiresInSeconds*1000 })`
→ returns `{ loggedIn: true, userHash, expiresAtMs }`. `iceServers` is ignored in
PR-4b (PR-5 owns ICE/TURN).

### 3.4 `sessionStore.ts`

```ts
export type SessionStore = {
  load(): StoredSession | null;
  save(s: StoredSession): void;
  clear(): void;
};
export function createSessionStore(deps?: {
  filePath?: string;                      // default app.getPath('userData')/mobile-remote-session.bin
  safeStorage?: typeof import('electron').safeStorage;
}): SessionStore;
```

`save` → `safeStorage.encryptString(JSON.stringify(s))` → write bytes to
`filePath`. `load` → read bytes → `safeStorage.decryptString` → JSON.parse;
returns `null` on missing file, decrypt failure, or parse failure (never throws
to callers). If `safeStorage.isEncryptionAvailable()` is false (rare Linux
headless), `save` no-ops and `load` returns `null` — login still works for the
session in memory, just not persisted; the pane shows a "not persisted" note.

### 3.5 `oauthTokenProvider.ts`

```ts
export function createOauthTokenProvider(store: SessionStore): TokenProvider {
  return () => {
    const s = store.load();
    if (!s) return null;
    if (s.expiresAtMs <= Date.now()) return null;   // expired → controller no-ops
    return { token: s.token, doUrl: s.doUrl };
  };
}
```

This is the object passed to `startMobileRemote({ tokenProvider })` at
`main.ts:302`. Signature identical to PR-4's env reader → controller code path
unchanged.

### 3.6 IPC pair

```
MOBILE_REMOTE_CHANNELS = {
  login:     'mobileRemote:login',      // invoke → MobileRemoteAuthState
  authState: 'mobileRemote:authState',  // invoke → MobileRemoteAuthState
  logout:    'mobileRemote:logout',     // invoke → MobileRemoteAuthState (loggedOut)
  onState:   'mobileRemote:onState',    // push → MobileRemoteAuthState
}
```

`MobileRemoteAuthState = { loggedIn: boolean; userHash: string | null; expiresAtMs: number | null; persisted: boolean }`.

Handlers in `electron/ipc/mobileRemoteIpc.ts`:
- `login` → `loginWithGithub(...)`, then **restart the peer** (close old
  `mobileRemote`, call `startMobileRemote({tokenProvider})` again) so the user
  doesn't have to relaunch, then broadcast `onState`.
- `logout` → `store.clear()`, close the peer (`mobileRemote?.close()`),
  broadcast.
- `authState` → derive from `store.load()`.

`main.ts` exposes a small `restartMobileRemote()` closure to the IPC module
(passed at registration) so the IPC layer doesn't reach into `main.ts` globals.

---

## 4. Data flow

```
Settings "Log in with GitHub"
  → window.ccsm.mobileRemoteLogin()
  → ipcMain 'mobileRemote:login'
  → oauthWindow popup: load /auth/github/start
       → GitHub authorize → Worker /auth/github/callback
       → callback HTML: window.opener.postMessage({authCode})
       → faux-opener preload → ipc 'mobileRemote:oauthMessage' → main
  → POST /auth/session {authCode} → {token, userHash, doUrl, expiresInSeconds}
  → sessionStore.save (safeStorage-encrypted blob on disk)
  → restartMobileRemote(): startMobileRemote({ tokenProvider: oauthTokenProvider })
       → controller builds doUrl?token=… → doSignalingClient → desktop peer
  → broadcast authState → pane shows "Logged in as <userHash short> · phone remote enabled"
```

On app start: `main.ts` builds `oauthTokenProvider` from the on-disk session and
passes it to `startMobileRemote()` — silent reuse when the JWT is still valid.

---

## 5. Error handling

| Failure | Behavior |
| --- | --- |
| User closes popup before auth | `runOauthPopup` rejects → `login` returns current (logged-out) state; pane shows "Login cancelled". No throw to renderer. |
| Popup 120 s timeout | Same as cancel, message "Login timed out". |
| `/auth/session` non-2xx / bad JSON | reject → pane "Login failed, try again". Nothing persisted. |
| `safeStorage` unavailable | session kept in memory for the run; `persisted:false`; pane note "won't survive restart on this OS". |
| Stored JWT expired on launch | provider returns null → peer stays off; pane shows "Session expired — log in again". |
| Message from a non-popup sender | ignored (sender `webContents` id check). |
| Popup loads a non-Worker origin (shouldn't happen) | preload asserts `location.origin === workerOrigin` before forwarding; otherwise ignores. |

---

## 6. Renewal honesty (scope guard)

Detail §4.2 says "首次登录后把 refresh 能力存在安全存储,后续重启静默续期". The Worker
**today** issues only a 15-min session JWT + a 60-s auth_code; there is no
long-lived refresh token endpoint. So PR-4b's "silent renewal" = **reuse the
persisted session JWT while it is unexpired**; when expired, the pane prompts a
one-click re-login (the popup, already authorized at GitHub, typically completes
without re-consent). A true refresh-token grant is a Worker change and is **not**
in PR-4b — noted as a follow-up. This keeps PR-4b honest and Worker-untouched.

---

## 7. Testing strategy

All new electron modules are pure/injected → plain-Node vitest (no real
`electron`, mirroring PR-4's `vi.mock('../../ptyHost')` discipline).

- `sessionStore.test.ts` — inject a fake `safeStorage` (encrypt = identity-ish)
  + temp file; round-trip save/load/clear; decrypt-failure → null;
  unavailable → no-op + null.
- `oauthLogin.test.ts` — inject `runPopup` returning `{authCode:'AC'}` + fake
  `fetchSession` returning a session; assert `store.save` got the right
  `expiresAtMs`; assert returned authState. Popup-reject path → logged-out state,
  nothing saved.
- `oauthTokenProvider.test.ts` — store returns fresh → `{token,doUrl}`; expired →
  null; empty → null.
- `oauthWindow.test.ts` — inject a fake `createWindow` whose webContents emits an
  IPC-like message; assert resolves with `{authCode}`; close-without-code →
  reject; wrong-sender → ignored.
- `mobileRemoteIpc.test.ts` — fake handlers registry; `login` calls
  `restartMobileRemote`; `logout` clears + closes + broadcasts.
- `MobileRemotePane.test.tsx` — render with a fake `window.ccsm`; click login →
  calls `mobileRemoteLogin`; renders logged-in/-out/expired states.

**Evidence limits (must state in PR):** these prove the *wiring*. They are **not**
public-internet evidence and **not** real-OAuth evidence (GitHub + real Worker
are mocked). The popup faux-opener interplay with the real Worker callback can
only be confirmed on a real run — flagged for the PR-5 real-device pass, where
the user logs in for real over 4G. (memory: strong-evidence-to-merge.)

---

## 8. Out-of-scope confirmations

- Controller (`mobileRemoteController.ts`), `doSignalingClient.ts`,
  `desktopPeer.ts`, phone side — untouched.
- No Worker (`cloudflare/`) changes. The existing
  start/callback/session routes are used as-is.
- No TURN/ICE work (PR-5).
- No tray UI.
- `tokenProvider.ts` env reader stays (handy for loopback e2e / CI without a
  real login).
