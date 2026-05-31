# PR-4b Desktop GitHub OAuth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR-4's env-var token provider with a real desktop GitHub OAuth login (popup `BrowserWindow` that intercepts the Worker callback's `postMessage`), persist the session via Electron `safeStorage`, and surface login/logout/status in a new Settings pane — so `startMobileRemote()` returns a live peer for a logged-in user. The `mobileRemoteController` is untouched.

**Architecture:** Desktop opens `…/auth/github/start` in a modal popup whose preload injects a faux `window.opener` forwarding `{authCode}` over IPC. Main exchanges the authCode at `POST /auth/session`, stores `{token,doUrl,userHash,expiresAtMs}` `safeStorage`-encrypted on disk, builds an `oauthTokenProvider` from it, and injects it into `startMobileRemote()`. A Settings "Mobile remote" pane drives login/logout and shows status. No Cloudflare Worker changes.

**Tech Stack:** Electron (main `BrowserWindow`, `safeStorage`, `ipcMain`), TypeScript, React (renderer pane), vitest (plain-Node + jsdom), existing Cloudflare Worker (unchanged).

**Base branch:** `feat/mobile-remote-web-exposure` (tip `ba707dc`). **Create the dev worktree from `origin/feat/mobile-remote-web-exposure`, NOT from this planning worktree** (this worktree is detached at an older commit `e0133b0` and does NOT contain PR-4's merged code).

**Authority:** `docs/superpowers/specs/2026-05-31-mobile-remote-pr4b-desktop-oauth-design.md`. Worker contract verified against `ba707dc`: `/auth/github/start` (302, fixed redirect_uri), `/auth/github/callback` (HTML → `window.opener.postMessage({authCode},"*")`), `POST /auth/session` body `{authCode}` → `{token,userHash,doUrl,iceServers,expiresInSeconds}`.

---

## Pre-flight (do once, before Task 1)

- [ ] **P1: Create the worktree from the correct base**

```bash
git fetch origin
git worktree add -b feat/mobile-remote-pr4b <path>/pr4b origin/feat/mobile-remote-web-exposure
cd <path>/pr4b
git rev-parse HEAD   # MUST equal ba707dc...
test -f electron/remote/tokenProvider.ts && echo "OK: PR-4 code present" || echo "WRONG BASE"
```

Expected: HEAD is `ba707dc`, `tokenProvider.ts` present, message "OK: PR-4 code present".

- [ ] **P2: Confirm baseline green**

Run: `npm install && npm run typecheck && npm run lint && npm test`
Expected: all green (this is the untouched merged baseline).

---

## Task 1: sessionStore (safeStorage-encrypted session on disk)

**Files:**
- Create: `electron/remote/sessionStore.ts`
- Test: `electron/remote/__tests__/sessionStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/remote/__tests__/sessionStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore, type StoredSession } from '../sessionStore';

// Fake safeStorage: "encrypts" by base64 so we exercise encode/decode paths.
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  } as unknown as typeof import('electron').safeStorage;
}

const sample: StoredSession = {
  token: 'JWT', doUrl: 'wss://w/do/abc', userHash: 'abc', expiresAtMs: 1_000_000,
};

describe('sessionStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccsm-ss-')); file = join(dir, 's.bin'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips save → load', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    store.save(sample);
    expect(store.load()).toEqual(sample);
  });

  it('load returns null when file missing', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    expect(store.load()).toBeNull();
  });

  it('clear removes the session', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    store.save(sample);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('load returns null on decrypt failure', () => {
    const broken = { ...fakeSafeStorage(), decryptString: () => { throw new Error('bad'); } } as unknown as typeof import('electron').safeStorage;
    const good = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage() });
    good.save(sample);
    const bad = createSessionStore({ filePath: file, safeStorage: broken });
    expect(bad.load()).toBeNull();
  });

  it('save no-ops and persisted is false when encryption unavailable', () => {
    const store = createSessionStore({ filePath: file, safeStorage: fakeSafeStorage(false) });
    store.save(sample);
    expect(store.load()).toBeNull();
    expect(store.isPersistAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/sessionStore.test.ts`
Expected: FAIL — `createSessionStore` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// electron/remote/sessionStore.ts
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import type { MobileRemoteLogin } from './tokenProvider';

export type StoredSession = MobileRemoteLogin & { userHash: string; expiresAtMs: number };

export type SessionStore = {
  load(): StoredSession | null;
  save(s: StoredSession): void;
  clear(): void;
  isPersistAvailable(): boolean;
};

type SafeStorage = typeof import('electron').safeStorage;

export function createSessionStore(deps: {
  filePath: string;
  safeStorage: SafeStorage;
}): SessionStore {
  const { filePath, safeStorage } = deps;
  const available = () => {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  };
  return {
    isPersistAvailable: available,
    save(s) {
      if (!available()) return;
      try { writeFileSync(filePath, safeStorage.encryptString(JSON.stringify(s))); } catch { /* ignore */ }
    },
    load() {
      try {
        const buf = readFileSync(filePath);
        const json = safeStorage.decryptString(buf);
        return JSON.parse(json) as StoredSession;
      } catch { return null; }
    },
    clear() {
      try { rmSync(filePath, { force: true }); } catch { /* ignore */ }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/sessionStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/sessionStore.ts electron/remote/__tests__/sessionStore.test.ts
git commit -m "feat(mobile-remote): safeStorage-backed session store for desktop OAuth"
```

---

## Task 2: oauthTokenProvider (TokenProvider over the store)

**Files:**
- Create: `electron/remote/oauthTokenProvider.ts`
- Test: `electron/remote/__tests__/oauthTokenProvider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/remote/__tests__/oauthTokenProvider.test.ts
import { describe, it, expect } from 'vitest';
import { createOauthTokenProvider } from '../oauthTokenProvider';
import type { SessionStore, StoredSession } from '../sessionStore';

function storeWith(s: StoredSession | null): SessionStore {
  return { load: () => s, save: () => {}, clear: () => {}, isPersistAvailable: () => true };
}

describe('oauthTokenProvider', () => {
  it('returns {token,doUrl} for a fresh session', () => {
    const p = createOauthTokenProvider(storeWith({ token: 'T', doUrl: 'wss://d', userHash: 'h', expiresAtMs: Date.now() + 60_000 }));
    expect(p()).toEqual({ token: 'T', doUrl: 'wss://d' });
  });
  it('returns null for an expired session', () => {
    const p = createOauthTokenProvider(storeWith({ token: 'T', doUrl: 'wss://d', userHash: 'h', expiresAtMs: Date.now() - 1 }));
    expect(p()).toBeNull();
  });
  it('returns null when no session', () => {
    expect(createOauthTokenProvider(storeWith(null))()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/oauthTokenProvider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// electron/remote/oauthTokenProvider.ts
import type { TokenProvider } from './tokenProvider';
import type { SessionStore } from './sessionStore';

export function createOauthTokenProvider(store: SessionStore): TokenProvider {
  return () => {
    const s = store.load();
    if (!s || s.expiresAtMs <= Date.now()) return null;
    return { token: s.token, doUrl: s.doUrl };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/oauthTokenProvider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/oauthTokenProvider.ts electron/remote/__tests__/oauthTokenProvider.test.ts
git commit -m "feat(mobile-remote): OAuth-backed TokenProvider derived from session store"
```

---

## Task 3: oauthLogin (popup → /auth/session → store)

**Files:**
- Create: `electron/remote/oauthLogin.ts`
- Test: `electron/remote/__tests__/oauthLogin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/remote/__tests__/oauthLogin.test.ts
import { describe, it, expect, vi } from 'vitest';
import { loginWithGithub } from '../oauthLogin';
import type { SessionStore, StoredSession } from '../sessionStore';

function memStore(): SessionStore & { saved: StoredSession | null } {
  let saved: StoredSession | null = null;
  return {
    load: () => saved, save: (s) => { saved = s; }, clear: () => { saved = null; },
    isPersistAvailable: () => true,
    get saved() { return saved; },
  } as SessionStore & { saved: StoredSession | null };
}

const ORIGIN = 'https://ccsm-worker.example.workers.dev';

describe('loginWithGithub', () => {
  it('exchanges authCode and persists session', async () => {
    const store = memStore();
    const fetchSession = vi.fn(async () => ({
      token: 'SESS', userHash: 'uh', doUrl: 'wss://w/do/uh',
      iceServers: [], expiresInSeconds: 900,
    }));
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const state = await loginWithGithub({
      workerOrigin: ORIGIN,
      runPopup: async () => ({ authCode: 'AC' }),
      fetchSession,
      store,
    });

    expect(fetchSession).toHaveBeenCalledWith(ORIGIN, 'AC');
    expect(store.saved).toEqual({ token: 'SESS', doUrl: 'wss://w/do/uh', userHash: 'uh', expiresAtMs: now + 900_000 });
    expect(state).toEqual({ loggedIn: true, userHash: 'uh', expiresAtMs: now + 900_000, persisted: true });
    vi.restoreAllMocks();
  });

  it('returns logged-out state and saves nothing when popup rejects', async () => {
    const store = memStore();
    const state = await loginWithGithub({
      workerOrigin: ORIGIN,
      runPopup: async () => { throw new Error('cancelled'); },
      fetchSession: vi.fn(),
      store,
    });
    expect(store.saved).toBeNull();
    expect(state.loggedIn).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/oauthLogin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// electron/remote/oauthLogin.ts
import type { SessionStore } from './sessionStore';

export type SessionResponse = {
  token: string; userHash: string; doUrl: string;
  iceServers: unknown[]; expiresInSeconds: number;
};

export type MobileRemoteAuthState = {
  loggedIn: boolean;
  userHash: string | null;
  expiresAtMs: number | null;
  persisted: boolean;
};

export async function fetchSession(workerOrigin: string, authCode: string): Promise<SessionResponse> {
  const res = await fetch(new URL('/auth/session', workerOrigin).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authCode }),
  });
  if (!res.ok) throw new Error(`session exchange failed: ${res.status}`);
  return (await res.json()) as SessionResponse;
}

export function loggedOut(): MobileRemoteAuthState {
  return { loggedIn: false, userHash: null, expiresAtMs: null, persisted: false };
}

export async function loginWithGithub(deps: {
  workerOrigin: string;
  runPopup: () => Promise<{ authCode: string }>;
  fetchSession: (workerOrigin: string, authCode: string) => Promise<SessionResponse>;
  store: SessionStore;
}): Promise<MobileRemoteAuthState> {
  let authCode: string;
  try {
    ({ authCode } = await deps.runPopup());
  } catch {
    return loggedOut();
  }
  const s = await deps.fetchSession(deps.workerOrigin, authCode);
  const expiresAtMs = Date.now() + s.expiresInSeconds * 1000;
  deps.store.save({ token: s.token, doUrl: s.doUrl, userHash: s.userHash, expiresAtMs });
  return {
    loggedIn: true,
    userHash: s.userHash,
    expiresAtMs,
    persisted: deps.store.isPersistAvailable(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/oauthLogin.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/oauthLogin.ts electron/remote/__tests__/oauthLogin.test.ts
git commit -m "feat(mobile-remote): orchestrate desktop OAuth popup → session exchange → store"
```

---

## Task 4: oauthWindow + popup preload (the BrowserWindow intercept)

**Files:**
- Create: `electron/remote/oauthWindow.ts`
- Create: `electron/remote/oauthPopupPreload.ts`
- Test: `electron/remote/__tests__/oauthWindow.test.ts`

**NOTE (load-bearing risk):** the faux-`window.opener` trick depends on the
popup preload running with `contextIsolation:false` BEFORE the Worker callback
script. Step 3 below includes a **runtime self-check** the dev MUST perform in
the real app (P-verify) — if the injected opener does not fire, fall back to
`webContents.on('did-finish-load')` + `executeJavaScript` reading the rendered
`{authCode}` from the page. Do NOT skip the verify.

- [ ] **Step 1: Write the failing test (event-driven, fake BrowserWindow)**

```ts
// electron/remote/__tests__/oauthWindow.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runOauthPopup } from '../oauthWindow';

function fakeWindow() {
  const wc = new EventEmitter() as EventEmitter & { id: number };
  wc.id = 42;
  const win = {
    webContents: wc,
    loadURL: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    on: (ev: string, cb: () => void) => { (win as any)._closed = cb; if (ev === 'closed') (win as any)._onClosed = cb; },
  };
  return { win, wc };
}

const ORIGIN = 'https://ccsm-worker.example.workers.dev';

describe('runOauthPopup', () => {
  it('resolves with authCode from the popup IPC message', async () => {
    const { win, wc } = fakeWindow();
    const ipc = new EventEmitter();
    const p = runOauthPopup({
      workerOrigin: ORIGIN,
      createWindow: () => win as any,
      ipcMain: ipc as any,
      timeoutMs: 1000,
    });
    // simulate the popup preload forwarding the Worker postMessage
    ipc.emit('mobileRemote:oauthMessage', { sender: { id: 42 } }, { authCode: 'AC' });
    await expect(p).resolves.toEqual({ authCode: 'AC' });
    expect(win.loadURL).toHaveBeenCalledWith(`${ORIGIN}/auth/github/start`);
    expect(win.close).toHaveBeenCalled();
  });

  it('ignores messages from a different sender', async () => {
    const { win } = fakeWindow();
    const ipc = new EventEmitter();
    const p = runOauthPopup({ workerOrigin: ORIGIN, createWindow: () => win as any, ipcMain: ipc as any, timeoutMs: 50 });
    ipc.emit('mobileRemote:oauthMessage', { sender: { id: 999 } }, { authCode: 'NOPE' });
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it('rejects when the window is closed without a code', async () => {
    const { win } = fakeWindow();
    const ipc = new EventEmitter();
    const p = runOauthPopup({ workerOrigin: ORIGIN, createWindow: () => win as any, ipcMain: ipc as any, timeoutMs: 1000 });
    (win as any)._onClosed?.();
    await expect(p).rejects.toThrow(/closed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/oauthWindow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// electron/remote/oauthWindow.ts
import path from 'node:path';
import type { BrowserWindow, IpcMain, BrowserWindowConstructorOptions } from 'electron';

const OAUTH_MESSAGE = 'mobileRemote:oauthMessage';

export function runOauthPopup(opts: {
  workerOrigin: string;
  parent?: BrowserWindow;
  timeoutMs?: number;
  createWindow?: (o: BrowserWindowConstructorOptions) => BrowserWindow;
  ipcMain?: IpcMain;
}): Promise<{ authCode: string }> {
  // Lazy electron import so this module is testable in plain Node.

  const electron = opts.createWindow && opts.ipcMain ? null : (require('electron') as typeof import('electron'));
  const make = opts.createWindow ?? ((o) => new electron!.BrowserWindow(o));
  const ipc = opts.ipcMain ?? electron!.ipcMain;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const win = make({
    width: 520, height: 640, modal: !!opts.parent, parent: opts.parent,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'oauthPopupPreload.js'),
      contextIsolation: false, nodeIntegration: false, sandbox: false,
    },
  });

  return new Promise<{ authCode: string }>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; cleanup(); fn(); };

    const onMessage = (ev: { sender: { id: number } }, msg: unknown) => {
      if (ev.sender?.id !== win.webContents.id) return;
      const code = (msg as { authCode?: unknown })?.authCode;
      if (typeof code === 'string' && code) finish(() => resolve({ authCode: code }));
    };
    const onClosed = () => finish(() => reject(new Error('oauth window closed')));
    const timer = setTimeout(() => finish(() => reject(new Error('oauth timeout'))), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ipc.removeListener(OAUTH_MESSAGE, onMessage as never);
      try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
    }

    ipc.on(OAUTH_MESSAGE, onMessage as never);
    win.on('closed', onClosed);
    win.loadURL(`${opts.workerOrigin}/auth/github/start`);
  });
}
```

```ts
// electron/remote/oauthPopupPreload.ts
/** Runs in the OAuth popup BrowserWindow (contextIsolation:false). The Worker
 *  callback page calls window.opener.postMessage({authCode}, "*"); standalone
 *  popups have no opener, so we supply one that forwards to the main process. */
import { ipcRenderer } from 'electron';

const WORKER_ORIGIN_PREFIX = 'https://ccsm-worker.';

Object.defineProperty(window, 'opener', {
  configurable: false,
  writable: false,
  value: {
    postMessage: (msg: unknown) => {
      // Only forward from the trusted Worker origin.
      if (!location.origin.startsWith(WORKER_ORIGIN_PREFIX)) return;
      ipcRenderer.send('mobileRemote:oauthMessage', msg);
    },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/oauthWindow.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Ensure the popup preload is built/copied**

Check how existing preloads are bundled (`electron/preload/index.ts` is compiled to `preload/index.js`). Confirm the build (`tsconfig`/webpack for electron) emits `electron/remote/oauthPopupPreload.ts` → a `.js` next to `oauthWindow.js`. If electron main is bundled (single file), instead point `preload` at the emitted preload path the bundler produces. Verify with: `npm run build` (or the electron-only build script) then `ls` the output dir for `oauthPopupPreload.js`. Adjust the `path.join` in `oauthWindow.ts` to the real emitted location.

- [ ] **Step 6: Commit**

```bash
git add electron/remote/oauthWindow.ts electron/remote/oauthPopupPreload.ts electron/remote/__tests__/oauthWindow.test.ts
git commit -m "feat(mobile-remote): OAuth popup window with faux-opener postMessage intercept"
```

---

## Task 5: IPC pair + main.ts wiring

**Files:**
- Create: `electron/ipc/mobileRemoteIpc.ts`
- Modify: `electron/shared/ipcChannels.ts` (add `MOBILE_REMOTE_CHANNELS`)
- Modify: `electron/main.ts:302` wiring + register IPC + `restartMobileRemote`
- Test: `electron/ipc/__tests__/mobileRemoteIpc.test.ts`

- [ ] **Step 1: Add channel constants**

In `electron/shared/ipcChannels.ts`, add:

```ts
export const MOBILE_REMOTE_CHANNELS = {
  login: 'mobileRemote:login',
  authState: 'mobileRemote:authState',
  logout: 'mobileRemote:logout',
  onState: 'mobileRemote:onState',
} as const;
```

- [ ] **Step 2: Write the failing test**

```ts
// electron/ipc/__tests__/mobileRemoteIpc.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registerMobileRemoteIpc } from '../mobileRemoteIpc';
import { MOBILE_REMOTE_CHANNELS } from '../../shared/ipcChannels';
import type { SessionStore } from '../../remote/sessionStore';

function fakeIpc() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  return {
    ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
    invoke: (ch: string, ...a: unknown[]) => handlers.get(ch)!(...a),
  };
}
function memStore(loggedIn: boolean): SessionStore {
  let s = loggedIn ? { token: 'T', doUrl: 'wss://d', userHash: 'h', expiresAtMs: Date.now() + 60_000 } : null;
  return { load: () => s, save: (x) => { s = x; }, clear: () => { s = null; }, isPersistAvailable: () => true };
}

describe('registerMobileRemoteIpc', () => {
  it('login runs the flow and restarts the peer', async () => {
    const { ipcMain, invoke } = fakeIpc();
    const store = memStore(false);
    const restart = vi.fn();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never,
      store,
      restartMobileRemote: restart,
      broadcast: () => {},
      doLogin: async () => ({ loggedIn: true, userHash: 'h', expiresAtMs: 123, persisted: true }),
    });
    const state = await invoke(MOBILE_REMOTE_CHANNELS.login);
    expect(state).toMatchObject({ loggedIn: true, userHash: 'h' });
    expect(restart).toHaveBeenCalled();
  });

  it('logout clears the store and restarts the peer', async () => {
    const { ipcMain, invoke } = fakeIpc();
    const store = memStore(true);
    const restart = vi.fn();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never, store, restartMobileRemote: restart,
      broadcast: () => {}, doLogin: async () => ({ loggedIn: false, userHash: null, expiresAtMs: null, persisted: true }),
    });
    const state = await invoke(MOBILE_REMOTE_CHANNELS.logout);
    expect(store.load()).toBeNull();
    expect(state).toMatchObject({ loggedIn: false });
    expect(restart).toHaveBeenCalled();
  });

  it('authState reflects the store', async () => {
    const { ipcMain, invoke } = fakeIpc();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never, store: memStore(true), restartMobileRemote: () => {},
      broadcast: () => {}, doLogin: async () => ({ loggedIn: false, userHash: null, expiresAtMs: null, persisted: true }),
    });
    const state = await invoke(MOBILE_REMOTE_CHANNELS.authState) as { loggedIn: boolean };
    expect(state.loggedIn).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/ipc/__tests__/mobileRemoteIpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// electron/ipc/mobileRemoteIpc.ts
import type { IpcMain } from 'electron';
import { MOBILE_REMOTE_CHANNELS } from '../shared/ipcChannels';
import type { SessionStore } from '../remote/sessionStore';
import { loggedOut, type MobileRemoteAuthState } from '../remote/oauthLogin';

function stateFromStore(store: SessionStore): MobileRemoteAuthState {
  const s = store.load();
  if (!s || s.expiresAtMs <= Date.now()) return loggedOut();
  return { loggedIn: true, userHash: s.userHash, expiresAtMs: s.expiresAtMs, persisted: store.isPersistAvailable() };
}

export function registerMobileRemoteIpc(deps: {
  ipcMain: IpcMain;
  store: SessionStore;
  restartMobileRemote: () => void;
  broadcast: (state: MobileRemoteAuthState) => void;
  doLogin: () => Promise<MobileRemoteAuthState>;
}): void {
  const { ipcMain, store, restartMobileRemote, broadcast, doLogin } = deps;

  ipcMain.handle(MOBILE_REMOTE_CHANNELS.login, async () => {
    const state = await doLogin();
    restartMobileRemote();
    broadcast(state);
    return state;
  });

  ipcMain.handle(MOBILE_REMOTE_CHANNELS.logout, async () => {
    store.clear();
    restartMobileRemote();
    const state = stateFromStore(store);
    broadcast(state);
    return state;
  });

  ipcMain.handle(MOBILE_REMOTE_CHANNELS.authState, async () => stateFromStore(store));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/ipc/__tests__/mobileRemoteIpc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire into main.ts**

In `electron/main.ts`: build the store + provider once, inject into
`startMobileRemote`, add a `restartMobileRemote` closure, register the IPC.

Replace `main.ts:302` `mobileRemote = startMobileRemote();` with the wiring (place the store/provider construction near the existing `let mobileRemote` at :160):

```ts
import { app, ipcMain, safeStorage } from 'electron';           // ensure safeStorage + ipcMain imported
import path from 'node:path';
import { createSessionStore } from './remote/sessionStore';
import { createOauthTokenProvider } from './remote/oauthTokenProvider';
import { registerMobileRemoteIpc } from './ipc/mobileRemoteIpc';
import { loginWithGithub, fetchSession, type MobileRemoteAuthState } from './remote/oauthLogin';
import { runOauthPopup } from './remote/oauthWindow';

const WORKER_ORIGIN = process.env.CCSM_MOBILE_REMOTE_WORKER ?? 'https://ccsm-worker.jiahuigu.workers.dev';
const sessionStore = createSessionStore({
  filePath: path.join(app.getPath('userData'), 'mobile-remote-session.bin'),
  safeStorage,
});
const oauthTokenProvider = createOauthTokenProvider(sessionStore);

function restartMobileRemote() {
  try { mobileRemote?.close(); } catch (err) { console.warn('[main] restart close threw', err); }
  mobileRemote = startMobileRemote({ tokenProvider: oauthTokenProvider });
}
```

At the existing `:302` call site:

```ts
  mobileRemote = startMobileRemote({ tokenProvider: oauthTokenProvider });
```

After the main window is created (where other IPC is registered), register:

```ts
registerMobileRemoteIpc({
  ipcMain,
  store: sessionStore,
  restartMobileRemote,
  broadcast: (state) => mainWindow?.webContents.send(MOBILE_REMOTE_CHANNELS.onState, state),
  doLogin: () =>
    loginWithGithub({
      workerOrigin: WORKER_ORIGIN,
      runPopup: () => runOauthPopup({ workerOrigin: WORKER_ORIGIN, parent: mainWindow ?? undefined }),
      fetchSession,
      store: sessionStore,
    }),
});
```

(Use the actual main-window variable name from `main.ts`; import `MOBILE_REMOTE_CHANNELS`.)

- [ ] **Step 7: typecheck + full unit run**

Run: `npm run typecheck && npx vitest run electron/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add electron/ipc/mobileRemoteIpc.ts electron/ipc/__tests__/mobileRemoteIpc.test.ts electron/shared/ipcChannels.ts electron/main.ts
git commit -m "feat(mobile-remote): wire desktop OAuth IPC + inject OAuth token provider into controller"
```

---

## Task 6: preload bridge + global.d.ts

**Files:**
- Modify: `electron/preload/bridges/ccsmCore.ts`
- Modify: `src/global.d.ts`

- [ ] **Step 1: Add to global.d.ts**

```ts
// in the window.ccsm interface
mobileRemoteLogin: () => Promise<MobileRemoteAuthState>;
mobileRemoteLogout: () => Promise<MobileRemoteAuthState>;
mobileRemoteAuthState: () => Promise<MobileRemoteAuthState>;
onMobileRemoteAuthState: (cb: (state: MobileRemoteAuthState) => void) => () => void;
```

Add the type (top of file, near other shared types):

```ts
type MobileRemoteAuthState = {
  loggedIn: boolean;
  userHash: string | null;
  expiresAtMs: number | null;
  persisted: boolean;
};
```

- [ ] **Step 2: Expose in ccsmCore.ts** (mirror `updatesStatus` + `onUpdateStatus`)

```ts
import { MOBILE_REMOTE_CHANNELS } from '../../shared/ipcChannels';
// ...inside the api object:
mobileRemoteLogin: () => ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.login),
mobileRemoteLogout: () => ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.logout),
mobileRemoteAuthState: () => ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.authState),
onMobileRemoteAuthState: (cb: (s: unknown) => void) => {
  const listener = (_e: unknown, s: unknown) => cb(s);
  ipcRenderer.on(MOBILE_REMOTE_CHANNELS.onState, listener);
  return () => ipcRenderer.removeListener(MOBILE_REMOTE_CHANNELS.onState, listener);
},
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add electron/preload/bridges/ccsmCore.ts src/global.d.ts
git commit -m "feat(mobile-remote): expose mobile-remote auth IPC on window.ccsm"
```

---

## Task 7: Settings pane

**Files:**
- Create: `src/components/settings/MobileRemotePane.tsx`
- Modify: `src/components/SettingsDialog.tsx` (add `mobile` tab)
- Modify: `src/i18n/locales/en.json` + `zh.json` (strings)
- Test: `src/components/settings/__tests__/MobileRemotePane.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/settings/__tests__/MobileRemotePane.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MobileRemotePane } from '../MobileRemotePane';

const authState = (over = {}) => ({ loggedIn: false, userHash: null, expiresAtMs: null, persisted: true, ...over });

beforeEach(() => {
  (window as unknown as { ccsm: unknown }).ccsm = {
    mobileRemoteAuthState: vi.fn(async () => authState()),
    mobileRemoteLogin: vi.fn(async () => authState({ loggedIn: true, userHash: 'abcdef0123' })),
    mobileRemoteLogout: vi.fn(async () => authState()),
    onMobileRemoteAuthState: vi.fn(() => () => {}),
  };
});

describe('MobileRemotePane', () => {
  it('shows a login button when logged out and calls login on click', async () => {
    render(<MobileRemotePane />);
    const btn = await screen.findByRole('button', { name: /log in with github/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect((window as unknown as { ccsm: { mobileRemoteLogin: ReturnType<typeof vi.fn> } }).ccsm.mobileRemoteLogin).toHaveBeenCalled(),
    );
  });

  it('shows logged-in status and a logout button after login', async () => {
    render(<MobileRemotePane />);
    fireEvent.click(await screen.findByRole('button', { name: /log in with github/i }));
    expect(await screen.findByRole('button', { name: /log out/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/__tests__/MobileRemotePane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** (mirror `UpdatesPane.tsx` structure/imports — match the real `Field`/`Button` props in that file)

```tsx
// src/components/settings/MobileRemotePane.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from './Field';
import { Button } from './Button';

type AuthState = { loggedIn: boolean; userHash: string | null; expiresAtMs: number | null; persisted: boolean };

export function MobileRemotePane() {
  const { t } = useTranslation();
  const [state, setState] = useState<AuthState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.ccsm?.mobileRemoteAuthState().then(setState);
    const off = window.ccsm?.onMobileRemoteAuthState(setState);
    return () => off?.();
  }, []);

  const login = async () => { setBusy(true); try { setState(await window.ccsm!.mobileRemoteLogin()); } finally { setBusy(false); } };
  const logout = async () => { setBusy(true); try { setState(await window.ccsm!.mobileRemoteLogout()); } finally { setBusy(false); } };

  const loggedIn = state?.loggedIn ?? false;

  return (
    <div>
      <Field label={t('settings.mobileRemote.status')}>
        <span>
          {loggedIn
            ? t('settings.mobileRemote.loggedInAs', { id: state?.userHash?.slice(0, 8) ?? '' })
            : t('settings.mobileRemote.loggedOut')}
        </span>
      </Field>
      {loggedIn && state?.persisted === false && (
        <Field label="">{t('settings.mobileRemote.notPersisted')}</Field>
      )}
      <Field label="">
        {loggedIn
          ? <Button onClick={logout} disabled={busy}>{t('settings.mobileRemote.logout')}</Button>
          : <Button onClick={login} disabled={busy}>{t('settings.mobileRemote.login')}</Button>}
      </Field>
    </div>
  );
}
```

- [ ] **Step 4: Add to SettingsDialog.tsx**

- Add `'mobile'` to the `Tab` union (`SettingsDialog.tsx:13`).
- Add `{ id: 'mobile', ... }` to `TABS` (`:17`), with label key `settings.tabs.mobileRemote`.
- Add id→label mapping where the others are (`:75-84`).
- Add render branch (`:170`): `{tab === 'mobile' && <MobileRemotePane />}` and import it.

- [ ] **Step 5: Add i18n strings**

`src/i18n/locales/en.json`:
```json
"settings": {
  "tabs": { "mobileRemote": "Mobile remote" },
  "mobileRemote": {
    "status": "Status",
    "loggedInAs": "Logged in as {{id}} — phone remote enabled",
    "loggedOut": "Not logged in",
    "login": "Log in with GitHub",
    "logout": "Log out",
    "notPersisted": "Login won't survive restart on this OS (no secure storage)."
  }
}
```
`src/i18n/locales/zh.json` (mirror keys):
```json
"settings": {
  "tabs": { "mobileRemote": "手机远程" },
  "mobileRemote": {
    "status": "状态",
    "loggedInAs": "已登录 {{id}} — 手机远程已启用",
    "loggedOut": "未登录",
    "login": "使用 GitHub 登录",
    "logout": "退出登录",
    "notPersisted": "此系统无安全存储,登录信息不会在重启后保留。"
  }
}
```
(Merge into existing `settings` objects; do not duplicate the key.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/components/settings/__tests__/MobileRemotePane.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/MobileRemotePane.tsx src/components/settings/__tests__/MobileRemotePane.test.tsx src/components/SettingsDialog.tsx src/i18n/locales/en.json src/i18n/locales/zh.json
git commit -m "feat(mobile-remote): settings pane for desktop GitHub login/logout/status"
```

---

## Task 8: Full gate + real-app verify

- [ ] **Step 1: Local pre-push gate (ALL must be green)**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green, `--max-warnings 0` clean.

- [ ] **Step 2: Real-app smoke (P-verify the faux-opener)**

Run: `npm run dev`. Open Settings → Mobile remote → "Log in with GitHub".
Verify in a real run:
1. Popup opens to the GitHub authorize page.
2. After authorizing, the popup reaches the Worker callback and **closes by itself**.
3. The pane flips to "Logged in as …".
4. Restart the app → still logged in (session persisted).

If the popup does NOT auto-close / pane does NOT flip, the faux-opener didn't
fire → implement the Task 4 fallback (`webContents` `did-finish-load` +
`executeJavaScript` reading the rendered `{authCode}` from the callback page)
and re-verify. **Do not report done until this real-run check passes** — this is
the user-visible behavior that headless tests cannot cover (memory:
strong-evidence-to-merge).

- [ ] **Step 3: Report to parent (NO self-merge, NO self-review)**

Push the branch, open a PR targeting `feat/mobile-remote-web-exposure`, report
the PR number + the gate output + the real-app verify result (screenshots of the
logged-in pane + a note on persistence-after-restart) to the parent session.
**Do NOT call `gh pr merge`.** Wait for an independent reviewer.

---

## Self-review checklist (done by plan author)

- **Spec coverage:** §3 components → Tasks 1-7; §4 flow → Task 5 wiring + Task 4 popup; §5 errors → Task 3 reject path + Task 1 decrypt-null; §6 renewal honesty → provider returns null on expiry (Task 2) + pane "expired" handled via loggedOut; §7 tests → each task's test. ✓
- **Placeholder scan:** none — every code step has full code. The only "match the real prop names" notes (Field/Button in Task 7, main-window var in Task 5) are explicit adaptation points, not placeholders. ✓
- **Type consistency:** `MobileRemoteAuthState` identical in oauthLogin.ts / IPC / global.d.ts / pane; `StoredSession` = `MobileRemoteLogin & {userHash,expiresAtMs}` used consistently; `TokenProvider` signature matches PR-4's. ✓
- **Risk flagged:** the faux-opener (Task 4) has a runtime verify + fallback in Task 8 Step 2. ✓
