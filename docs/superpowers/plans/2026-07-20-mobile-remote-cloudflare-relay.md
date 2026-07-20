# Mobile Remote Cloudflare Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a CI-configured desktop installer that lets one phone scan one QR code and securely control CCSM terminal sessions through a free Cloudflare Worker and Durable Object relay.

**Architecture:** A Worker serves the phone PWA and routes two outbound WebSocket connections into one Durable Object room. Desktop and phone authenticate with a desktop-generated pairing capability, derive directional AES-GCM keys, and carry the existing mobile terminal protocol inside encrypted envelopes. Electron loads the relay controller after first paint, exposes status through a typed preload bridge, and never gives the renderer direct Electron imports.

**Tech Stack:** Electron 41, Node 22 Web Crypto, TypeScript 5.7, React 18, xterm.js 5.5, WebSocket (`ws`), Cloudflare Workers + Durable Objects + Wrangler, webpack 5, Vitest 4, Playwright 1.59, GitHub Actions, npm only.

## Global Constraints

- Use npm only; never run pnpm or yarn.
- Node must remain `>=22.0.0`.
- The renderer under `src/` must communicate with main only through `window.ccsm*`.
- The installed flow has no URL entry, secret entry, Wrangler command, domain, port forwarding, VPN, Tailscale, or Cloudflare dashboard step.
- Scope remains one desktop, one phone, and CCSM terminal sessions only.
- Cloudflare must receive only room metadata and encrypted terminal frames.
- No WebRTC, STUN, TURN, `werift`, or native transport dependency.
- The public relay controller must load after `app.whenReady()` and must never block window creation.
- Preserve the existing `sessions.list`, `session.snapshot`, `session.input`, `session.resize`, `pty.data`, snapshot, and PTY sequence semantics.
- Keep the existing loopback mobile server available for local diagnostics until the relay path is proven.
- Add English and Chinese copy together.
- Each behavior change starts with a failing test and ends with the smallest targeted passing test command.

## File Structure

### Shared browser-safe protocol

- `src/shared/mobileRemote/protocol.ts` — protocol versions, roles, handshake messages, encrypted envelope schema, and terminal message types.
- `src/shared/mobileRemote/crypto.ts` — base64url helpers, HMAC transcript proof, HKDF directional keys, AES-GCM seal/open, and replay guard.
- `src/shared/mobileRemote/index.ts` — public exports shared by desktop and phone.

### Cloudflare relay

- `cloudflare/src/worker.ts` — HTTP asset fallback, WebSocket upgrade validation, and room routing.
- `cloudflare/src/relayRoom.ts` — one-desktop/one-phone Durable Object, frame forwarding, role replacement, idle cleanup, and limits.
- `cloudflare/src/limits.ts` — room, origin, frame, handshake, and connection-limit validation.
- `cloudflare/wrangler.jsonc` — Worker name, Durable Object binding/migration, compatibility date, and static assets.
- `cloudflare/vitest.config.ts` — Workers test project.
- `cloudflare/test/*.test.ts` — Worker and room contract tests.

### Phone PWA

- `src/mobile/index.ts` — page bootstrap only.
- `src/mobile/pairing.ts` — fragment parsing, IndexedDB persistence, and history cleanup.
- `src/mobile/relayClient.ts` — WSS lifecycle, encrypted handshake, heartbeat, and reconnect.
- `src/mobile/phoneApp.ts` — terminal protocol state, snapshot recovery, and PTY sequence dedupe.
- `src/mobile/phonePage.ts` — DOM structure, session chips, status, key bar, and viewport behavior.
- `src/phone.html`, `src/mobile/manifest.webmanifest`, `src/mobile/sw.ts` — PWA shell.
- `webpack.mobile.config.js` — isolated browser bundle into `dist/mobile`.

### Desktop

- `electron/remote/pairingStore.ts` — `safeStorage`-backed pairing identity persistence.
- `electron/remote/relayConfig.ts` — packaged `mobileRemoteRelayUrl` and development override validation.
- `electron/remote/relaySocket.ts` — reconnecting `ws` transport and heartbeat.
- `electron/remote/encryptedPeer.ts` — shared handshake/envelope adapter implementing the terminal peer interface.
- `electron/remote/remotePeer.ts` — transport-neutral `RemotePeer` contract.
- `electron/remote/ptyFanout.ts` — reusable per-session PTY output forwarding.
- `electron/remote/mobileRemoteController.ts` — lifecycle, status, pause/resume, rotate, and pairing URL.
- `electron/ipc/mobileRemoteIpc.ts` — validated renderer actions and status fan-out.
- `electron/preload/bridges/ccsmMobileRemote.ts` — `window.ccsmMobileRemote`.

### Renderer and delivery

- `src/components/settings/MobileRemotePane.tsx` — zero-configuration QR and status UI.
- `src/components/SettingsDialog.tsx` — mobile-remote settings tab.
- `src/global.d.ts` — renderer bridge types.
- `src/i18n/locales/en.ts`, `src/i18n/locales/zh.ts` — complete copy.
- `scripts/stamp-mobile-remote-url.mjs` — validated release metadata injection.
- `.github/workflows/release.yml` — deploy relay before packaging and stamp URL into every installer.
- `.github/workflows/ci.yml` — Worker and phone build/test gates.
- `scripts/harness-e2e-mobile-remote-relay.mjs` — local Worker + simulated desktop + Playwright phone proof.

---

### Task 1: Shared Protocol and Cryptographic Channel

**Files:**
- Create: `src/shared/mobileRemote/protocol.ts`
- Create: `src/shared/mobileRemote/crypto.ts`
- Create: `src/shared/mobileRemote/index.ts`
- Create: `electron/remote/__tests__/mobileRemoteCrypto.test.ts`
- Create: `tests/mobile/mobileRemoteCrypto.test.ts`
- Modify: `tsconfig.electron.json`

**Interfaces:**
- Produces:
  - `MOBILE_REMOTE_PROTOCOL_VERSION = 1`
  - `RelayRole = 'desktop' | 'phone'`
  - `PairingIdentity = { roomId: string; secret: string }`
  - `HandshakeHello`, `HandshakeProof`, `EncryptedEnvelope`
  - `generatePairingIdentity(randomValues?)`
  - `createHandshakeProof(secret, transcript, subtle?)`
  - `deriveSessionKeys({ secret, roomId, desktopNonce, phoneNonce, role }, subtle?)`
  - `sealEnvelope(state, plaintext, subtle?)`
  - `openEnvelope(state, envelope, subtle?)`
- Consumes no application modules.

- [ ] **Step 1: Write failing Node and browser tests**

Use the same fixed vectors in both test projects:

```ts
const vector = {
  secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  roomId: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  desktopNonce: 'CCCCCCCCCCCCCCCCCCCCCC',
  phoneNonce: 'DDDDDDDDDDDDDDDDDDDDDD',
};

it('derives opposite directional keys and round-trips one envelope', async () => {
  const desktop = await deriveSessionKeys({ ...vector, role: 'desktop' });
  const phone = await deriveSessionKeys({ ...vector, role: 'phone' });
  const envelope = await sealEnvelope(desktop.send, utf8('{"type":"sessions.list"}'));
  await expect(openEnvelope(phone.receive, envelope)).resolves.toEqual(
    utf8('{"type":"sessions.list"}'),
  );
});

it('rejects replay and authenticated-data tampering', async () => {
  const desktop = await deriveSessionKeys({ ...vector, role: 'desktop' });
  const phone = await deriveSessionKeys({ ...vector, role: 'phone' });
  const envelope = await sealEnvelope(desktop.send, utf8('secret'));
  await openEnvelope(phone.receive, envelope);
  await expect(openEnvelope(phone.receive, envelope)).rejects.toThrow('replayed_frame');
  await expect(openEnvelope(phone.receive, { ...envelope, connectionId: 'tampered' }))
    .rejects.toThrow('invalid_frame');
});
```

- [ ] **Step 2: Run the focused tests and confirm missing-module failures**

Run:

```powershell
npx vitest run --project electron electron/remote/__tests__/mobileRemoteCrypto.test.ts
npx vitest run --project renderer tests/mobile/mobileRemoteCrypto.test.ts
```

Expected: both fail because `src/shared/mobileRemote` does not exist.

- [ ] **Step 3: Implement the versioned protocol and Web Crypto primitives**

Define exact wire shapes in `protocol.ts`:

```ts
export const MOBILE_REMOTE_PROTOCOL_VERSION = 1 as const;
export type RelayRole = 'desktop' | 'phone';

export type HandshakeHello = {
  type: 'handshake.hello';
  version: typeof MOBILE_REMOTE_PROTOCOL_VERSION;
  role: RelayRole;
  connectionId: string;
  nonce: string;
};

export type HandshakeProof = {
  type: 'handshake.proof';
  connectionId: string;
  proof: string;
};

export type EncryptedEnvelope = {
  type: 'encrypted';
  version: typeof MOBILE_REMOTE_PROTOCOL_VERSION;
  connectionId: string;
  sequence: number;
  ciphertext: string;
};
```

In `crypto.ts`, use `globalThis.crypto.subtle`, HMAC-SHA-256, HKDF-SHA-256,
and AES-256-GCM. Encode the connection ID, direction, version, and sequence as
authenticated additional data. Construct a 12-byte AES-GCM IV from an
HKDF-derived 4-byte prefix plus an unsigned 64-bit big-endian sequence. Reject
`sequence <= receive.lastSequence` before decryption and update the replay
counter only after successful authentication. Add `"DOM"` to
`tsconfig.electron.json`'s `lib` so the shared Web Crypto types compile in both
projects.

- [ ] **Step 4: Run shared tests, typecheck, and lint**

Run:

```powershell
npx vitest run --project electron electron/remote/__tests__/mobileRemoteCrypto.test.ts
npx vitest run --project renderer tests/mobile/mobileRemoteCrypto.test.ts
npm run typecheck
npm run lint
```

Expected: all pass with no warnings.

- [ ] **Step 5: Commit the shared channel**

```powershell
git add src/shared/mobileRemote electron/remote/__tests__/mobileRemoteCrypto.test.ts tests/mobile/mobileRemoteCrypto.test.ts tsconfig.electron.json
git commit -m "feat(remote): add encrypted mobile protocol"
```

### Task 2: Cloudflare Worker and Durable Object Relay

**Files:**
- Create: `cloudflare/src/limits.ts`
- Create: `cloudflare/src/relayRoom.ts`
- Create: `cloudflare/src/worker.ts`
- Create: `cloudflare/wrangler.jsonc`
- Create: `cloudflare/vitest.config.ts`
- Create: `cloudflare/test/limits.test.ts`
- Create: `cloudflare/test/worker.test.ts`
- Create: `cloudflare/test/relayRoom.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes `RelayRole` and protocol constants from `src/shared/mobileRemote`.
- Produces `RelayRoom` Durable Object and default Worker `fetch`.
- Relay URL contract:
  `GET /relay/<43-char-base64url-room>?role=desktop|phone` with WebSocket upgrade.

- [ ] **Step 1: Install Cloudflare development dependencies and write failing limits tests**

Run:

```powershell
npm install --save-dev wrangler @cloudflare/workers-types @cloudflare/vitest-pool-workers
```

Add tests asserting:

```ts
expect(parseRelayRequest(new Request('https://x/relay/bad?role=desktop'))).toEqual({
  ok: false,
  status: 400,
});
expect(parseRelayRequest(validDesktopUpgrade).value).toEqual({
  roomId: VALID_ROOM_ID,
  role: 'desktop',
});
expect(MAX_RELAY_FRAME_BYTES).toBe(1_048_576);
expect(HANDSHAKE_TIMEOUT_MS).toBe(10_000);
```

- [ ] **Step 2: Run the Worker tests and confirm missing exports**

Run:

```powershell
npx vitest run --config cloudflare/vitest.config.ts
```

Expected: fail because `limits.ts`, `worker.ts`, and `relayRoom.ts` do not exist.

- [ ] **Step 3: Implement routing and the one-desktop/one-phone room**

Use the Durable Object hibernation API:

```ts
export class RelayRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role') as RelayRole;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    for (const old of this.ctx.getWebSockets(role)) {
      old.close(4001, 'replaced');
    }
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, authenticated: false, connectedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_RELAY_FRAME_BYTES) {
      ws.close(1009, 'frame_too_large');
      return;
    }
    const { role } = ws.deserializeAttachment() as RelayAttachment;
    const peerRole: RelayRole = role === 'desktop' ? 'phone' : 'desktop';
    for (const peer of this.ctx.getWebSockets(peerRole)) peer.send(message);
  }
}
```

The Worker validates method, path, room format, role, `Upgrade: websocket`, and
the phone request's same-origin `Origin`. It delegates valid upgrades to
`env.RELAY.getByName(roomId).fetch(request)` and delegates other GET requests
to `env.ASSETS.fetch(request)`. Add handshake timers, desktop-absent idle cleanup, close propagation, and a
`RELAY_RATE_LIMITER` binding checked with the request's `CF-Connecting-IP`
before creating a room. Configure a limit of 20 upgrade attempts per 60 seconds
per Cloudflare location key; return HTTP 429 without creating a Durable Object
when the binding rejects the request.

- [ ] **Step 4: Configure the Worker and run tests**

`wrangler.jsonc` must include:

```json
{
  "name": "ccsm-mobile-remote",
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-20",
  "durable_objects": {
    "bindings": [{ "name": "RELAY", "class_name": "RelayRoom" }]
  },
  "ratelimits": [
    {
      "name": "RELAY_RATE_LIMITER",
      "namespace_id": "1001",
      "simple": { "limit": 20, "period": 60 }
    }
  ],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RelayRoom"] }],
  "assets": { "directory": "../dist/mobile", "binding": "ASSETS" }
}
```

Run:

```powershell
npx vitest run --config cloudflare/vitest.config.ts
npx wrangler deploy --config cloudflare/wrangler.jsonc --dry-run
npm run typecheck
npm run lint
```

Expected: tests pass and Wrangler reports a valid dry-run bundle.

- [ ] **Step 5: Commit the relay**

```powershell
git add cloudflare package.json package-lock.json
git commit -m "feat(remote): add Cloudflare relay worker"
```

### Task 3: Phone PWA and Encrypted Relay Client

**Files:**
- Create: `src/mobile/index.ts`
- Create: `src/mobile/pairing.ts`
- Create: `src/mobile/relayClient.ts`
- Create: `src/mobile/phoneApp.ts`
- Create: `src/mobile/phonePage.ts`
- Create: `src/mobile/mobile.css`
- Create: `src/mobile/manifest.webmanifest`
- Create: `src/mobile/sw.ts`
- Create: `src/phone.html`
- Create: `webpack.mobile.config.js`
- Create: `tests/mobile/pairing.test.ts`
- Create: `tests/mobile/relayClient.test.ts`
- Create: `tests/mobile/phoneApp.test.ts`
- Modify: `package.json`
- Modify: `webpack.config.js`

**Interfaces:**
- Consumes shared protocol/crypto and existing xterm packages.
- Produces `createRelayClient(options): RelayClient`, where:

```ts
type RelayClient = {
  connect(): void;
  send(message: MobileClientMessage): Promise<void>;
  close(): void;
  onMessage(handler: (message: MobileServerMessage) => void): () => void;
  onStatus(handler: (status: PhoneConnectionStatus) => void): () => void;
};
```

- [ ] **Step 1: Write failing pairing, reconnect, and sequence tests**

Cover these exact behaviors:

```ts
it('imports #pair, stores it, and removes it from history', async () => {
  location.hash = `#pair=${ROOM_ID}.${SECRET}`;
  await importPairingFromFragment(store);
  expect(store.put).toHaveBeenCalledWith({ roomId: ROOM_ID, secret: SECRET });
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
});

it('drops live chunks already covered by a snapshot', () => {
  const state = applySnapshot(emptyPhoneState(), { sid: 's1', seq: 8, data: 'full' });
  expect(applyPtyData(state, { sid: 's1', seq: 8, chunk: 'duplicate' })).toBe(state);
  expect(applyPtyData(state, { sid: 's1', seq: 9, chunk: 'new' }).terminalWrites).toEqual(['new']);
});
```

Use a fake WebSocket to assert reconnect delays cap at 10 seconds, fresh
handshake nonces are generated per connection, wrong protocol versions surface
`update_required`, and encrypted messages are not emitted before proof
verification.

- [ ] **Step 2: Run phone tests and confirm missing-module failures**

Run:

```powershell
npx vitest run --project renderer tests/mobile
```

Expected: fail because the phone modules do not exist.

- [ ] **Step 3: Implement the PWA without external runtime assets**

Build the mobile UI from local `@xterm/xterm` and `@xterm/addon-fit` imports.
Port the session strip, hard-key bar, sticky Ctrl, `visualViewport` handling,
resize messages, status copy, exponential backoff, snapshot repaint, and PTY
sequence dedupe from `electron/remote/mobilePage.ts`. Keep protocol state in
`phoneApp.ts`, DOM rendering in `phonePage.ts`, credential storage in
`pairing.ts`, and transport/crypto in `relayClient.ts`.

Configure `webpack.mobile.config.js` with:

```js
entry: {
  phone: './src/mobile/index.ts',
  sw: './src/mobile/sw.ts'
},
output: {
  path: path.resolve(__dirname, 'dist/mobile'),
  filename: '[name].[contenthash].js',
  clean: true
},
plugins: [
  new HtmlWebpackPlugin({ template: './src/phone.html', chunks: ['phone'] }),
  new CopyPlugin({ patterns: [{ from: 'src/mobile/manifest.webmanifest' }] })
]
```

Add `build:mobile` and include it in `build`. Set a strict CSP in the HTML and
register the service worker only after successful secure-origin load.

- [ ] **Step 4: Run phone tests and production bundle**

Run:

```powershell
npx vitest run --project renderer tests/mobile
npm run build:mobile
npm run typecheck
npm run lint
```

Expected: tests pass; `dist/mobile/index.html`, hashed JS/CSS, manifest, and
service worker exist; no CDN URL appears in the output.

- [ ] **Step 5: Commit the phone client**

```powershell
git add src/mobile src/phone.html tests/mobile webpack.mobile.config.js webpack.config.js package.json package-lock.json
git commit -m "feat(remote): add phone control PWA"
```

### Task 4: Desktop Pairing Store and Relay Controller

**Files:**
- Create: `electron/remote/remotePeer.ts`
- Create: `electron/remote/ptyFanout.ts`
- Create: `electron/remote/pairingStore.ts`
- Create: `electron/remote/relayConfig.ts`
- Create: `electron/remote/relaySocket.ts`
- Create: `electron/remote/encryptedPeer.ts`
- Create: `electron/remote/mobileRemoteController.ts`
- Create: `electron/remote/__tests__/pairingStore.test.ts`
- Create: `electron/remote/__tests__/relayConfig.test.ts`
- Create: `electron/remote/__tests__/relaySocket.test.ts`
- Create: `electron/remote/__tests__/mobileRemoteController.test.ts`
- Modify: `electron/remote/remoteMessages.ts`
- Modify: `electron/remote/mobileRemoteServer.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces:

```ts
export interface RemotePeer {
  subscribedSid: string | null;
  send(payload: MobileServerMessage): void;
}

export type MobileRemoteStatus =
  | { kind: 'unavailable'; reason: 'relay-not-configured' | 'secure-storage-unavailable' }
  | { kind: 'connecting' }
  | { kind: 'ready'; phoneConnected: false }
  | { kind: 'ready'; phoneConnected: true }
  | { kind: 'paused' }
  | { kind: 'error'; reason: 'relay-unreachable' | 'protocol-mismatch' | 'authentication-failed' };

export interface MobileRemoteController {
  getStatus(): MobileRemoteStatus;
  getPairingUrl(): string | null;
  pause(): void;
  resume(): void;
  rotate(): Promise<void>;
  subscribe(handler: (status: MobileRemoteStatus) => void): () => void;
  close(): void;
}
```

- Consumes shared crypto/protocol, `onPtyData`, and `handleClientMessage`.

- [ ] **Step 1: Install pure-JavaScript WebSocket support and write failing tests**

Run:

```powershell
npm install ws
npm install --save-dev @types/ws
```

Tests must prove:

- `safeStorage.isEncryptionAvailable() === false` returns
  `secure-storage-unavailable` and writes no file.
- a new store writes only encrypted bytes and returns the same identity later.
- packaged config accepts only `https://*.workers.dev`; development accepts
  `CCSM_MOBILE_REMOTE_RELAY_URL`.
- controller reconnect uses capped jittered backoff.
- phone proof failure never reaches `handleClientMessage`.
- PTY fan-out sends only to the currently subscribed SID.
- `rotate()` closes old sockets, deletes old credentials, and generates a new
  room/secret.

- [ ] **Step 2: Run focused desktop tests and confirm failures**

Run:

```powershell
npx vitest run --project electron electron/remote/__tests__/pairingStore.test.ts electron/remote/__tests__/relayConfig.test.ts electron/remote/__tests__/relaySocket.test.ts electron/remote/__tests__/mobileRemoteController.test.ts
```

Expected: missing-module failures.

- [ ] **Step 3: Refactor terminal handling behind `RemotePeer`**

Change `handleClientMessage(client: WsClient, raw: string)` to
`handleClientMessage(client: RemotePeer, raw: string)`. Move the existing
`onPtyData` subscription and SID gate into:

```ts
export function installPtyFanout(peers: ReadonlySet<RemotePeer>): () => void {
  return onPtyData((sid, chunk, seq) => {
    for (const peer of peers) {
      if (peer.subscribedSid === sid) peer.send({ type: 'pty.data', sid, chunk, seq });
    }
  });
}
```

Use the same helper from the loopback server and relay controller so protocol
behavior cannot drift.

- [ ] **Step 4: Implement secure storage, relay socket, encrypted peer, and controller**

Persist `{ roomId, secret }` as `safeStorage.encryptString(JSON.stringify(...))`
under `app.getPath('userData')/mobile-remote-pairing.bin`. Write with mode
`0o600` on POSIX; on Windows rely on the existing per-user `userData` ACL and
DPAPI-backed `safeStorage`. Validate decoded base64url lengths before use.

`relayConfig.ts` reads `mobileRemoteRelayUrl` from the packaged
`package.json`; unpackaged development falls back to
`CCSM_MOBILE_REMOTE_RELAY_URL`. `relaySocket.ts` owns only WSS lifecycle,
heartbeat, and reconnect. `encryptedPeer.ts` owns handshake and encryption.
`mobileRemoteController.ts` composes them, maps failures to status, and delays
protocol traffic until peer authentication succeeds.

- [ ] **Step 5: Run desktop and legacy loopback tests**

Run:

```powershell
npx vitest run --project electron electron/remote/__tests__ electron/__tests__/mobileRemoteServer.test.ts
npm run typecheck
npm run lint
```

Expected: new tests and all legacy mobile server tests pass.

- [ ] **Step 6: Commit the desktop controller**

```powershell
git add electron/remote package.json package-lock.json
git commit -m "feat(remote): add encrypted desktop relay controller"
```

### Task 5: Main Lifecycle, IPC, and Preload Bridge

**Files:**
- Create: `electron/ipc/mobileRemoteIpc.ts`
- Create: `electron/ipc/__tests__/mobileRemoteIpc.test.ts`
- Create: `electron/preload/bridges/ccsmMobileRemote.ts`
- Create: `electron/preload/bridges/__tests__/ccsmMobileRemote.test.ts`
- Modify: `electron/shared/ipcChannels.ts`
- Modify: `electron/preload/index.ts`
- Modify: `electron/preload/bridges/__tests__/index.test.ts`
- Modify: `electron/main.ts`
- Modify: `src/global.d.ts`

**Interfaces:**
- Adds `MOBILE_REMOTE_CHANNELS`:

```ts
export const MOBILE_REMOTE_CHANNELS = {
  status: 'mobileRemote:status',
  getStatus: 'mobileRemote:getStatus',
  getPairingUrl: 'mobileRemote:getPairingUrl',
  pause: 'mobileRemote:pause',
  resume: 'mobileRemote:resume',
  rotate: 'mobileRemote:rotate',
} as const;
```

- Exposes `window.ccsmMobileRemote` with matching methods and
  `onStatus(handler): () => void`.

- [ ] **Step 1: Write failing IPC and preload tests**

Assert all channels register, malformed renderer payloads cannot reach the
controller, bridge listeners unsubscribe correctly, and preload index installs
the bridge once. Add a main-load regression that mocks the dynamic controller
import to reject and still observes window startup wiring.

- [ ] **Step 2: Run focused tests and confirm missing APIs**

Run:

```powershell
npx vitest run --project electron electron/ipc/__tests__/mobileRemoteIpc.test.ts electron/preload/bridges/__tests__/ccsmMobileRemote.test.ts electron/preload/bridges/__tests__/index.test.ts
```

Expected: fail because the channel catalog, registrar, and bridge are absent.

- [ ] **Step 3: Implement typed IPC and preload wiring**

`registerMobileRemoteIpc` receives a controller getter and a window getter:

```ts
export function registerMobileRemoteIpc({
  ipcMain,
  getController,
}: {
  ipcMain: IpcMain;
  getController: () => MobileRemoteController | null;
}): void {
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.getStatus, () =>
    getController()?.getStatus() ?? { kind: 'unavailable', reason: 'relay-not-configured' },
  );
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.getPairingUrl, () =>
    getController()?.getPairingUrl() ?? null,
  );
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.pause, () => getController()?.pause());
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.resume, () => getController()?.resume());
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.rotate, () => getController()?.rotate());
}
```

The bridge uses `ipcRenderer.invoke` and one removable status listener. Mirror
the exact status union in `src/global.d.ts`.

- [ ] **Step 4: Replace eager loopback startup with guarded public-controller bootstrap**

Keep the loopback server behind `CCSM_MOBILE_REMOTE=1` for diagnostics. For the
public controller, add a post-ready function:

```ts
async function startPublicMobileRemote(): Promise<void> {
  try {
    const { createMobileRemoteController } = await import('./remote/mobileRemoteController');
    mobileRemoteController = await createMobileRemoteController();
  } catch (error) {
    console.error('[mobile-remote] public controller failed after app ready', error);
  }
}
```

Call it only after `createWindow`, IPC registration, and PTY registration are
complete. Dispose both controllers independently during shutdown.

- [ ] **Step 5: Run IPC, preload, lifecycle, typecheck, and lint**

Run:

```powershell
npx vitest run --project electron electron/ipc/__tests__/mobileRemoteIpc.test.ts electron/preload/bridges/__tests__
npm run typecheck
npm run lint
```

Expected: pass; `src/` still has no import from `electron/`.

- [ ] **Step 6: Commit the application boundary**

```powershell
git add electron/ipc electron/preload electron/shared/ipcChannels.ts electron/main.ts src/global.d.ts
git commit -m "feat(remote): expose mobile relay lifecycle"
```

### Task 6: Zero-Configuration Settings Experience

**Files:**
- Create: `src/components/settings/MobileRemotePane.tsx`
- Create: `tests/settings/MobileRemotePane.test.tsx`
- Modify: `src/components/SettingsDialog.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes `window.ccsmMobileRemote`.
- Produces no new main-process API.

- [ ] **Step 1: Install the QR renderer and write failing UI tests**

Run:

```powershell
npm install qrcode.react
```

Test:

```tsx
it('shows a ready QR without configuration fields', async () => {
  bridge.getStatus.mockResolvedValue({ kind: 'ready', phoneConnected: false });
  bridge.getPairingUrl.mockResolvedValue('https://relay.workers.dev/#pair=room.secret');
  render(<MobileRemotePane />);
  expect(await screen.findByLabelText('Phone pairing QR code')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByText(/Worker URL/i)).not.toBeInTheDocument();
});

it('rotates only after confirmation', async () => {
  render(<MobileRemotePane />);
  await user.click(await screen.findByRole('button', { name: 'Refresh QR code' }));
  expect(screen.getByRole('dialog', { name: 'Replace pairing?' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Replace' }));
  expect(bridge.rotate).toHaveBeenCalledTimes(1);
});
```

Also test connecting, phone-connected, paused, unavailable, error,
protocol-update, and secure-storage states.

- [ ] **Step 2: Run the pane test and confirm failure**

Run:

```powershell
npx vitest run --project renderer tests/settings/MobileRemotePane.test.tsx
```

Expected: fail because `MobileRemotePane` is missing.

- [ ] **Step 3: Implement the pane and settings tab**

Use `QRCodeSVG` with the pairing URL and an accessible title. Subscribe on
mount, unsubscribe on unmount, and re-fetch the pairing URL after `rotate()`.
Render:

- relay status badge,
- desktop and phone connection states,
- QR code when ready,
- refresh QR with destructive confirmation,
- pause/resume action,
- actionable packaged/development errors.

Add `'mobileRemote'` to the `Tab` union, tab catalog, refs, IDs, panels, and
render branch in `SettingsDialog.tsx`.

- [ ] **Step 4: Add complete English and Chinese copy**

Add matching keys under `settings.tabs.mobileRemote` and
`settings.mobileRemote.*`. Include labels for ready, connecting, phone
connected, waiting, paused, relay unavailable, secure storage unavailable,
update required, refresh confirmation, pause, resume, and QR accessibility.

- [ ] **Step 5: Run pane, settings, typecheck, and lint**

Run:

```powershell
npx vitest run --project renderer tests/settings/MobileRemotePane.test.tsx tests/settings
npm run typecheck
npm run lint
```

Expected: all pass and no accessibility warning is emitted.

- [ ] **Step 6: Commit the desktop UX**

```powershell
git add src/components src/i18n tests/settings package.json package-lock.json
git commit -m "feat(remote): add zero-config pairing UI"
```

### Task 7: CI Deployment and Installer Relay Configuration

**Files:**
- Create: `scripts/stamp-mobile-remote-url.mjs`
- Create: `electron/remote/__tests__/stampMobileRemoteUrl.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/reference/release.md`

**Interfaces:**
- `stampMobileRemoteUrl(packagePath, relayUrl)` validates HTTPS and
  `workers.dev`, then writes top-level `mobileRemoteRelayUrl`.
- Release workflow requires GitHub Secrets `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` and repository variable
  `CLOUDFLARE_WORKERS_SUBDOMAIN`.

- [ ] **Step 1: Write failing metadata-stamp tests**

Test valid stamping and all rejected inputs:

```ts
await stampMobileRemoteUrl(tempPackage, 'https://ccsm-mobile-remote.owner.workers.dev');
expect(readPackage(tempPackage).mobileRemoteRelayUrl).toBe(
  'https://ccsm-mobile-remote.owner.workers.dev',
);
await expect(stampMobileRemoteUrl(tempPackage, 'http://localhost:8787'))
  .rejects.toThrow('invalid_relay_url');
await expect(stampMobileRemoteUrl(tempPackage, 'https://example.com'))
  .rejects.toThrow('invalid_relay_url');
```

- [ ] **Step 2: Run the script test and confirm failure**

Run:

```powershell
npx vitest run --project electron electron/remote/__tests__/stampMobileRemoteUrl.test.ts
```

Expected: fail because the script is missing.

- [ ] **Step 3: Implement URL stamping and package scripts**

Export the function for tests and run it from CLI:

```js
const parsed = new URL(relayUrl);
if (
  parsed.protocol !== 'https:' ||
  !parsed.hostname.endsWith('.workers.dev') ||
  parsed.pathname !== '/'
) {
  throw new Error('invalid_relay_url');
}
pkg.mobileRemoteRelayUrl = parsed.origin;
```

Add `build:mobile`, `test:cloudflare`, and `cloudflare:dry-run` scripts.

- [ ] **Step 4: Add CI gates**

In `ci.yml`, after the normal build/test steps on Ubuntu, run:

```yaml
- name: Test Cloudflare relay
  if: matrix.os == 'ubuntu-latest'
  run: npm run test:cloudflare
- name: Dry-run Cloudflare bundle
  if: matrix.os == 'ubuntu-latest'
  run: npm run cloudflare:dry-run
```

- [ ] **Step 5: Deploy before packaging and stamp every release artifact**

Add `deploy-mobile-remote` after `verify`:

```yaml
deploy-mobile-remote:
  needs: verify
  runs-on: ubuntu-latest
  outputs:
    relay_url: ${{ steps.relay.outputs.url }}
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '22'
        cache: npm
    - run: npm ci --legacy-peer-deps
    - run: npm run build:mobile
    - run: npx wrangler deploy --config cloudflare/wrangler.jsonc
      env:
        CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    - id: relay
      shell: bash
      run: echo "url=https://ccsm-mobile-remote.${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}.workers.dev" >> "$GITHUB_OUTPUT"
```

Make `build` depend on both `verify` and `deploy-mobile-remote`. Before
`npm run build`, run:

```yaml
- name: Stamp relay URL into package metadata
  run: node scripts/stamp-mobile-remote-url.mjs package.json "${{ needs.deploy-mobile-remote.outputs.relay_url }}"
```

Fail early with a named error if required secrets or the subdomain variable are
empty. Keep Cloudflare credentials out of build artifacts and logs.

- [ ] **Step 6: Run workflow syntax and local gates**

Run:

```powershell
npm run test:cloudflare
npm run cloudflare:dry-run
npm run build
npm run typecheck
npm run lint
```

Expected: all pass; local package metadata remains unstamped after tests.

- [ ] **Step 7: Commit delivery automation**

```powershell
git add scripts package.json package-lock.json .github/workflows docs/reference
git commit -m "ci(remote): deploy relay before packaging"
```

### Task 8: End-to-End Proof, Documentation, and Final Verification

**Files:**
- Create: `scripts/harness-e2e-mobile-remote-relay.mjs`
- Modify: `scripts/run-all-e2e.mjs`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/reference/e2e-runner.md`
- Modify: `docs/superpowers/specs/2026-07-20-mobile-remote-cloudflare-relay-design.md`

**Interfaces:**
- Consumes the local Wrangler dev server, shared crypto, simulated PTY seams,
  and built phone assets.
- Produces one automated proof command through the existing `npm run probe:e2e`.

- [ ] **Step 1: Add a failing relay harness to the e2e runner**

The harness must:

1. start `wrangler dev` on a selected localhost port,
2. create a simulated desktop relay client with a generated room and secret,
3. open the phone page in Playwright with the pairing fragment,
4. complete the encrypted handshake,
5. assert session list and snapshot rendering,
6. type a command and observe it at the simulated PTY input seam,
7. emit PTY output and observe it in xterm,
8. interrupt the phone network, restore it, and assert snapshot/sequence
   recovery,
9. rotate the pairing identity and assert the old phone cannot reconnect, and
10. terminate only processes it started by exact PID.

Register it in `scripts/run-all-e2e.mjs`.

- [ ] **Step 2: Run the focused harness and observe the first real integration failure**

Run:

```powershell
npm run build
node scripts/harness-e2e-mobile-remote-relay.mjs
```

Expected before fixes: fail at the earliest incomplete integration seam, with
the harness cleaning up Wrangler and browser processes.

- [ ] **Step 3: Fix integration seams without weakening assertions**

Adjust only production boundaries exposed by the failure. Keep these final
assertions:

```js
assert.equal(await phone.locator('[data-remote-status]').textContent(), 'Connected');
assert.match(await phone.locator('.xterm-rows').textContent(), /snapshot-ready/);
assert.deepEqual(simulatedDesktop.inputs, ['echo mobile-e2e\r']);
assert.equal(oldCredentialReconnectResult, 'authentication-failed');
```

- [ ] **Step 4: Update user and maintainer documentation**

Document:

- installed flow: open Settings → Mobile Remote → scan,
- one-user/one-phone scope,
- terminal-only control,
- pause and QR rotation,
- Cloudflare free-tier dependency,
- required repository secrets/variable for maintainers,
- release ordering and failure behavior,
- local development relay override,
- the prior `werift` failure and the guarded lazy-load rule.

Mark the design status implemented only after all gates pass.

- [ ] **Step 5: Run complete verification**

Run:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run probe:e2e
npm run cloudflare:dry-run
```

Expected: every command exits 0; the production build contains the phone
assets; no `werift`, TURN, STUN, Tailscale, CDN xterm URL, or plaintext pairing
secret appears in packaged runtime code or logs.

- [ ] **Step 6: Request a focused code review**

Use the repository review workflow to inspect the full branch diff, with
special attention to cryptographic nonce uniqueness, replay handling, Worker
room isolation, `safeStorage` failure behavior, main-window startup isolation,
and release artifact URL stamping. Address every high-confidence finding and
rerun the affected focused tests.

- [ ] **Step 7: Commit the end-to-end feature**

```powershell
git add scripts README.md docs
git commit -m "test(remote): prove Cloudflare phone control"
```

## Final Acceptance Checklist

- [ ] CI-produced installer contains the deployed Worker URL.
- [ ] Opening the mobile-remote settings pane immediately shows a QR code.
- [ ] One scan connects from a phone on a different network.
- [ ] Cloudflare only relays encrypted terminal payloads.
- [ ] Phone can list, switch, view, type into, and resize CCSM terminal sessions.
- [ ] Wi-Fi/cellular changes reconnect and restore from snapshot without duplicate output.
- [ ] Refreshing the QR invalidates the previous phone credential.
- [ ] Pausing remote control closes remote access without damaging local sessions.
- [ ] Relay or crypto failure cannot prevent the main window from painting.
- [ ] Cloudflare secrets stay in GitHub Actions only.
- [ ] Normal single-user operation remains within the Cloudflare free plan.
