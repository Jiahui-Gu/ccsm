# Mobile Terminal Independent Viewport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one desktop-sized canonical Claude PTY while the phone renders the same ordered terminal history in an independently pannable, readable viewport with a persistent accessible scrollbar.

**Architecture:** The main-process PTY entry owns canonical columns, rows, geometry epoch, sequence, and a single serialized publication queue. A visible desktop measurement commits an ordered resize/snapshot barrier through the existing preload boundary; the phone extends its existing strict snapshot/live reducer to install that barrier atomically, while xterm and React separately manage physical horizontal pan, vertical scroll controls, and per-session history anchors.

**Tech Stack:** Electron 41, React 18, TypeScript 5.7, zustand vanilla, xterm.js 5.5 (`@xterm/xterm`, `@xterm/headless`, `@xterm/addon-serialize`), Vitest 4, Testing Library, Playwright, encrypted WebSocket relay.

## Global Constraints

- Use npm only; never run pnpm or yarn.
- Use Node `>=22.0.0`.
- Keep `package.json` version `0.2.20`; the wire protocol version changes independently.
- Renderer code under `src/` must access main-process behavior through typed preload APIs on `window.ccsm`; it must never import from `electron/`.
- Keep exactly one Claude PTY and one canonical logical `cols x rows` per live session.
- Only the currently visible desktop terminal may request canonical PTY resize.
- Hidden desktop shells, phone layout, `visualViewport`, software keyboard, orientation, browser zoom, and phone fit measurements must never resize the PTY.
- Keep phone xterm read-only: no `onData`, no terminal/helper `focus()` or `blur()`, and no keyboard entry outside the composer.
- Preserve strict per-session PTY sequence plus monotonic geometry epoch; never apply bytes under a different geometry.
- Keep the existing bounded recovery limit exactly `MAX_BUFFERED_TERMINAL_CHUNKS = 256`.
- Preserve pairing, encrypted-envelope sequencing, crypto primitives, frame bounds, no-plaintext logging, and secret-handling behavior.
- A desktop resize is one ordered authoritative snapshot barrier; no mixed-geometry chunks, duplicate bytes, gaps, cursor corruption, font scaling, composer movement, or focus change.
- Do not implement the separately tracked phone Send fix in this feature.
- Do not deploy, tag, release, or change updater behavior during implementation.
- Do not modify user snapshots or generated physical-test evidence already present in the working tree.

---

## Existing Code Map and Locked File Responsibilities

The implementation starts from approved spec
`docs/superpowers/specs/2026-07-23-mobile-terminal-viewport-design.md:1-329`.
Current symbols and responsibilities are:

| Area | Current file and symbols | Planned responsibility |
|---|---|---|
| Browser-safe wire contract | `src/shared/mobileRemote/protocol.ts:6-84` (`MOBILE_REMOTE_PROTOCOL_VERSION`, `MobileClientMessage`, `SessionSnapshotMessage`, `MobileServerMessage`) | Define canonical geometry, geometry epochs, authoritative snapshot barriers, epoch-tagged chunks, protocol guards, and remove phone resize. |
| Relay client validation/recovery queue | `src/mobile/relayClient.ts:28-68,196-238,409-423` (`RelayClient`, `RecoveryMessage`, `isRecoveryMessage`, encrypted message decode) | Validate decrypted application messages before delivery and stop treating phone resize as recoverable. |
| PTY entry state and chunk dispatch | `electron/ptyHost/entryFactory.ts:64-99,150-220,302-336` (`Entry`, `dispatchPtyChunk`, `makeEntry`) | Retain canonical geometry and epoch and enqueue remote sync publication without changing desktop/notify raw sinks. |
| PTY lifecycle | `electron/ptyHost/lifecycle.ts:186-205,417-509` (`resize`, `BufferSnapshot`, `getBufferSnapshot`) | Validate origin, mutate canonical PTY/headless geometry, and expose an entry-level atomic snapshot primitive. |
| PTY singleton and IPC | `electron/ptyHost/index.ts:58-126`; `electron/ptyHost/ipcRegistrar.ts:180-222` | Bind the coordinator, accept resize only from the visible desktop BrowserWindow, and keep the typed preload boundary. |
| PTY fanout | `electron/ptyHost/dataFanout.ts:10-38`; `electron/remote/ptyFanout.ts:1-12` | Preserve existing raw listeners and add one ordered remote terminal-sync event stream for epoch chunks and barriers. |
| Remote requests/snapshots | `electron/remote/remoteMessages.ts:66-84,138-151`; `electron/remote/mobileRemoteController.ts:45-107` | Serve coordinated snapshots, publish barriers, and reject/remove `session.resize`. |
| Desktop resize callers | `src/terminal/usePtyAttachShell.ts:177-183,310-320,381-430`; `src/terminal/shellRegistry.ts:237-287,425-456` | Centralize visible-shell-only measurement and use a 140 ms drag debounce. |
| Preload/type surface | `electron/preload/bridges/ccsmPty.ts:17-51`; `src/pty.d.ts:9-80` | Keep `window.ccsmPty.resize` typed and include canonical geometry in attach/snapshot results. |
| Phone strict reducer | `src/mobile/terminalSync.ts:6-161` (`TerminalSyncState`, `TerminalSyncEffect`, `applyTerminalChunk`, `applyTerminalSnapshot`) | Extend the existing 256-chunk strict reducer with geometry epochs and atomic install effects. |
| Phone view store | `src/mobile/mobileRemoteStore.ts:27-81,361-402,469-492,527-564` | Preserve reducer effects as numbered batches, request one recovery snapshot, and carry session identity. |
| Phone xterm adapter | `src/mobile/mobileTerminalAdapter.ts:41-95,149-296` (`MobileXtermTerminal`, `MobileTerminalAdapter`, `createMobileTerminalAdapter`) | Apply canonical logical resize, expose scroll metrics/actions, report pixel extent, and treat phone layout as viewport-only. |
| Phone React wrapper | `src/mobile/components/MobileTerminal.tsx:33-80` | Own clipped horizontal viewport, per-session anchors, one adapter, and custom scrollbar composition. |
| Phone shell | `src/mobile/components/PhoneShell.tsx:93-167,267-273` | Remove phone resize transmission and pass selected session/batches into the viewport. |
| Phone CSS | `src/mobile/mobile.css:205-219` | Provide readable fixed font grid, horizontal overflow affordance, 24 px rail, 44 px thumb, forced-colors support. |
| Unit/integration tests | `tests/mobile/*.test.*`, `tests/terminal/shellRegistry.test.ts`, `electron/ptyHost/__tests__/*.test.ts`, `electron/remote/__tests__/*.test.ts` | Pin every authority, ordering, recovery, focus, scrolling, and accessibility contract. |
| Deterministic harnesses | `scripts/probe-helpers/mobileRemoteHarness.mjs:215-490`, `scripts/harness-e2e-mobile-terminal-sync.mjs:1-600`, `scripts/harness-e2e-mobile-remote-visual.mjs:1-302` | Model desktop canonical geometry and epoch barriers, exact parity, zero phone resize, pan/scrollbar, orientation, and keyboard. |

The following interfaces are locked for all tasks:

```ts
export type TerminalGeometry = {
  cols: number;
  rows: number;
  epoch: number;
};

export type PtyResizeOrigin = {
  kind: 'visible-desktop';
  webContentsId: number;
};

export type PtyInputOrigin =
  | { kind: 'desktop-renderer'; webContentsId: number }
  | { kind: 'mobile-control' };

export type TerminalSyncPublication =
  | {
      type: 'chunk';
      sid: string;
      seq: number;
      chunk: string;
      geometryEpoch: number;
    }
  | {
      type: 'barrier';
      sid: string;
      seq: number;
      snapshot: string;
      geometry: TerminalGeometry;
    };

export type TerminalViewportAnchor =
  | { mode: 'bottom'; horizontalOffsetPx: number; canonicalCols: number }
  | {
      mode: 'history';
      distanceFromBottom: number;
      horizontalOffsetPx: number;
      canonicalCols: number;
    };

export type TerminalScrollMetrics = {
  maximumTop: number;
  currentTop: number;
  visibleRows: number;
};

export type MobileTerminalAdapterFactory = (
  element: HTMLElement,
) => MobileTerminalAdapter;
```

### Task 1: Versioned Browser-Safe Geometry Protocol

**Files:**
- Modify: `src/shared/mobileRemote/protocol.ts:6-84`
- Modify: `src/shared/mobileRemote/index.ts`
- Modify: `src/mobile/relayClient.ts:28-68,196-238,409-423`
- Modify: `tests/mobile/relayClient.test.ts`
- Create: `tests/mobile/mobileRemoteProtocol.test.ts`

**Interfaces:**
- Consumes: Existing encrypted `HandshakeHello`, `EncryptedEnvelope`, `SessionNavigatorModel`, and `MAX_MOBILE_SUBMIT_CHARS`.
- Produces: `TerminalGeometry`, `SessionSnapshotMessage`, `PtyDataMessage`, `isMobileClientMessage(value: unknown): value is MobileClientMessage`, `isMobileServerMessage(value: unknown): value is MobileServerMessage`, and `MOBILE_REMOTE_PROTOCOL_VERSION = 2`.

- [ ] **Step 1: Write failing protocol contract tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  isMobileClientMessage,
  isMobileServerMessage,
} from '../../src/shared/mobileRemote';

describe('mobile terminal geometry protocol', () => {
  it('uses protocol version 2 and removes phone resize', () => {
    expect(MOBILE_REMOTE_PROTOCOL_VERSION).toBe(2);
    expect(isMobileClientMessage({ type: 'session.resize', sid: 's1', cols: 40, rows: 20 }))
      .toBe(false);
  });

  it('accepts a complete barrier and matching live chunk', () => {
    expect(isMobileServerMessage({
      type: 'session.snapshot',
      sid: 's1',
      seq: 9,
      snapshot: '\u001b[Hready',
      geometry: { cols: 120, rows: 30, epoch: 4 },
    })).toBe(true);
    expect(isMobileServerMessage({
      type: 'pty.data',
      sid: 's1',
      seq: 10,
      chunk: 'tail',
      geometryEpoch: 4,
    })).toBe(true);
    expect(isMobileServerMessage({
      type: 'sessions.list',
      sessions: [{
        sid: 's1',
        cwd: 'C:\\work',
        geometry: { cols: 120, rows: 30, epoch: 4 },
      }],
    })).toBe(true);
  });

  it.each([
    { cols: 0, rows: 30, epoch: 1 },
    { cols: 80.5, rows: 30, epoch: 1 },
    { cols: 80, rows: 1001, epoch: 1 },
    { cols: 80, rows: 30, epoch: -1 },
  ])('rejects unsafe geometry %#', (geometry) => {
    expect(isMobileServerMessage({
      type: 'session.snapshot',
      sid: 's1',
      seq: 1,
      snapshot: '',
      geometry,
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx vitest run tests/mobile/mobileRemoteProtocol.test.ts tests/mobile/relayClient.test.ts
```

Expected: FAIL because version `1`, `session.resize`, geometry fields, and message guards still have the old contract.

- [ ] **Step 3: Implement the exact shared types and guards**

```ts
export const MOBILE_REMOTE_PROTOCOL_VERSION = 2 as const;
export const MAX_TERMINAL_DIMENSION = 1000;

export type TerminalGeometry = {
  cols: number;
  rows: number;
  epoch: number;
};

export type MobileClientMessage =
  | { type: 'sessions.list' }
  | { type: 'session.snapshot'; sid: string }
  | { type: 'session.input'; sid: string; data: string }
  | { type: 'session.submit'; sid: string; requestId: string; draft: string };

export type SessionListEntry = {
  sid: string;
  cwd: string;
  geometry: TerminalGeometry;
};

export type SessionSnapshotMessage = {
  type: 'session.snapshot';
  sid: string;
  seq: number;
  snapshot: string;
  geometry: TerminalGeometry;
};

export type PtyDataMessage = {
  type: 'pty.data';
  sid: string;
  seq: number;
  chunk: string;
  geometryEpoch: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function isTerminalGeometry(value: unknown): value is TerminalGeometry {
  if (!isRecord(value)) return false;
  return (
    isSafeInteger(value.cols, 1, MAX_TERMINAL_DIMENSION) &&
    isSafeInteger(value.rows, 1, MAX_TERMINAL_DIMENSION) &&
    isSafeInteger(value.epoch, 0, Number.MAX_SAFE_INTEGER)
  );
}
```

Complete both discriminated-union guards in `protocol.ts`: require non-empty `sid`,
safe non-negative sequence numbers, required `snapshot` for snapshots, required
`geometryEpoch` for chunks, existing submit bounds, and the existing navigator
version. Export them from `src/shared/mobileRemote/index.ts`. In
`relayClient.ts`, parse decrypted JSON as `unknown`, call `isMobileServerMessage`,
and fail the current socket with `invalid_message` before invoking handlers when
validation fails. Remove `session.resize` from `RecoveryMessage`,
`isRecoveryMessage`, and `recoveryKey`.

- [ ] **Step 4: Add relay delivery rejection coverage**

```ts
it('rejects an authenticated malformed geometry message before delivery', async () => {
  const socket = new FakeWebSocket();
  const messages: unknown[] = [];
  const client = createRelayClient({
    relayUrl: 'https://relay.example',
    pairing: { roomId: ROOM_ID, secret: SECRET },
    createWebSocket: () => socket,
    randomValues: (bytes) => (bytes.fill(17), bytes),
  });
  client.onMessage((message) => messages.push(message));
  client.connect();
  socket.open();
  await authenticate(client, socket, 'M'.repeat(22));
  const phoneHello = parseSent(socket).find((message) => message.type === 'handshake.hello')!;
  const desktopKeys = await deriveSessionKeys({
    secret: SECRET,
    roomId: ROOM_ID,
    desktopNonce: 'M'.repeat(22),
    phoneNonce: String(phoneHello.nonce),
    role: 'desktop',
  });
  const envelope = await sealEnvelope(
    desktopKeys.send,
    new TextEncoder().encode(JSON.stringify({
      type: 'pty.data',
      sid: 's1',
      seq: 1,
      chunk: 'bad',
      geometryEpoch: -1,
    })),
  );
  socket.receive(envelope);
  await vi.waitFor(() => expect(socket.readyState).toBe(3));
  expect(messages).toEqual([]);
  client.close();
});
```

Use the existing `FakeWebSocket`, `authenticate`, `deriveSessionKeys`, and
`sealEnvelope` helpers in `tests/mobile/relayClient.test.ts`; do not create an
unencrypted test-only receive path.

- [ ] **Step 5: Run targeted tests and verify GREEN**

Run:

```bash
npx vitest run tests/mobile/mobileRemoteProtocol.test.ts tests/mobile/relayClient.test.ts
```

Expected: PASS; malformed decrypted application messages never reach store handlers.

- [ ] **Step 6: Commit**

```bash
git add src/shared/mobileRemote/protocol.ts src/shared/mobileRemote/index.ts src/mobile/relayClient.ts tests/mobile/mobileRemoteProtocol.test.ts tests/mobile/relayClient.test.ts
git commit -m "feat(mobile): version terminal geometry protocol"
```

### Task 2: Main-Process Canonical Geometry and Resize Authority

**Files:**
- Modify: `electron/ptyHost/entryFactory.ts:64-99,302-336`
- Modify: `electron/ptyHost/lifecycle.ts:186-205`
- Modify: `electron/ptyHost/index.ts:58-104`
- Modify: `electron/ptyHost/ipcRegistrar.ts:98-109,181-244`
- Modify: `electron/remote/remoteMessages.ts:86-151`
- Modify: `electron/ptyHost/__tests__/lifecycle.test.ts`
- Modify: `electron/ptyHost/__tests__/ipcRegistrar.test.ts`
- Modify: `electron/remote/__tests__/remoteMessages.test.ts`

**Interfaces:**
- Consumes: `TerminalGeometry` from Task 1 and current `Entry.cols`, `Entry.rows`, `Entry.seq`.
- Produces: `PtyResizeOrigin`, `PtyInputOrigin`,
  `resizeCanonicalGeometry(registry, sid, cols, rows, origin): TerminalGeometry | null`,
  `getCanonicalGeometry(registry, sid): TerminalGeometry | null`, and
  origin-typed `input(registry, sid, data, origin): void`.

- [ ] **Step 0: Inspect resize-ownership donor `b730487c` read-only**

Do not cherry-pick `b730487c` wholesale. Inspect its exact patch and ownership
evidence before writing Task 2 tests:

```bash
git show --stat --oneline --decorate --no-renames b730487c
git diff --name-status b730487c^ b730487c
git show --format=fuller --no-ext-diff b730487c -- electron/remote/remoteMessages.ts electron/remote/mobilePage.ts src/mobile/components/PhoneShell.tsx electron/remote/__tests__/remoteMessages.test.ts tests/mobile/PhoneShell.test.tsx scripts/harness-e2e-mobile-remote-visual.mjs scripts/harness-e2e-mobile-terminal-sync.mjs scripts/probe-helpers/mobileRemoteHarness.mjs
git grep -n -E "FitAddon|getDimensions|setSessionDimensions|phoneDims|session\\.resize" b730487c -- electron/remote src/mobile tests/mobile scripts
```

Expected: all commands succeed; the name-status output lists the donor's 13
changed files. The focused diff shows:

- ownership RED tests proving a legacy `session.resize` never calls
  `resizePtySession`;
- `electron/remote/mobilePage.ts` and current React
  `src/mobile/components/PhoneShell.tsx` removing outgoing phone resize;
- the valid legacy `session.resize` compatibility path becoming a no-PTY no-op,
  while malformed legacy payloads still return `invalid_resize`;
- Chromium/browser harness evidence that records zero outgoing phone resize.

The donor's simulated desktop is evidence for the ownership RED test, not the
real-Electron result. Carry its before/after observation into a real production
Electron reproduction with isolated user data:

```powershell
npm run build
$env:CCSM_PROD_BUNDLE = '1'
$env:NODE_ENV = 'production'
npx electron . "--user-data-dir=$env:TEMP\ccsm-mobile-viewport-authority"
```

In the visible desktop session, run
`node -p "process.stdout.columns + 'x' + process.stdout.rows"` before pairing
the phone and again after portrait, keyboard-open, keyboard-close, and
landscape transitions. Expected: every reading is identical until the visible
desktop window itself is resized; the isolated profile leaves the user's
existing snapshot untouched. Reuse this exact method in Task 10's public-relay
physical acceptance.

Selectively port only those ownership RED tests/evidence, the legacy remote
no-PTY behavior, outgoing resize removal in both current React and legacy
`mobilePage`, and the real Electron before/after reproduction procedure. Keep
the Task 1 versioned protocol removal as the current-client path; the legacy
branch exists only for already-deployed clients and must never mutate PTY state.
Apply the remote compatibility slice in Task 2, the React and legacy sender
removal in Task 8, and the deterministic/real-Electron evidence in Tasks 9 and
10; do not create a donor-shaped parallel implementation.

Explicitly do not port any of these donor behaviors:

- phone-local `FitAddon` results calling `terminal.resize`;
- `getDimensions()` treating phone fit as canonical geometry;
- `setSessionDimensions(phoneDims)` or equivalent parity coercion in the
  simulated desktop;
- authoritative headless/reference terminals being resized to phone dimensions;
- any assertion that permits canonical parity to differ across physical
  viewports.

The implementation must compare the phone serialization with the authoritative
desktop headless terminal at desktop canonical dimensions. `git cherry-pick
b730487c` is forbidden in this task.

- [ ] **Step 1: Write failing lifecycle authority tests**

```ts
it('retains canonical geometry and increments epoch only for a changed desktop size', () => {
  const entry = makeFakeEntry({ cols: 120, rows: 30, geometryEpoch: 0 });
  const registry = new Map([['s1', entry]]);
  const origin = { kind: 'visible-desktop', webContentsId: 7 } as const;

  expect(L.resizeCanonicalGeometry(registry as never, 's1', 120, 30, origin)).toBeNull();
  expect(entry.geometryEpoch).toBe(0);

  expect(L.resizeCanonicalGeometry(registry as never, 's1', 150, 42, origin)).toEqual({
    cols: 150,
    rows: 42,
    epoch: 1,
  });
  expect(entry.pty.resize).toHaveBeenCalledWith(150, 42);
  expect(entry.headless.resize).toHaveBeenCalledWith(150, 42);
});

it('types input origin without changing PTY bytes', () => {
  const entry = makeFakeEntry({ geometryEpoch: 0 });
  const registry = new Map([['s1', entry]]);
  L.input(registry as never, 's1', '\u0003', { kind: 'mobile-control' });
  expect(entry.pty.write).toHaveBeenCalledWith('\u0003');
});
```

Extend the existing test-local `FakeEntry` and `makeFakeEntry` with
`geometryEpoch: number`, defaulting to `0`; reuse the existing fake PTY and
headless resize spies.

- [ ] **Step 2: Run the lifecycle and remote tests and verify RED**

Run:

```bash
npx vitest run electron/ptyHost/__tests__/lifecycle.test.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts electron/remote/__tests__/remoteMessages.test.ts
```

Expected: FAIL because `Entry.geometryEpoch`, resize/input origin types, and
phone resize rejection do not exist.

- [ ] **Step 3: Add canonical state and origin-typed lifecycle operations**

```ts
export type PtyResizeOrigin = {
  kind: 'visible-desktop';
  webContentsId: number;
};

export type PtyInputOrigin =
  | { kind: 'desktop-renderer'; webContentsId: number }
  | { kind: 'mobile-control' };

export function getCanonicalGeometry(
  registry: Map<string, Entry>,
  sid: string,
): TerminalGeometry | null {
  const entry = registry.get(sid);
  return entry
    ? { cols: entry.cols, rows: entry.rows, epoch: entry.geometryEpoch }
    : null;
}

export function resizeCanonicalGeometry(
  registry: Map<string, Entry>,
  sid: string,
  cols: number,
  rows: number,
  _origin: PtyResizeOrigin,
): TerminalGeometry | null {
  const entry = registry.get(sid);
  if (!entry || (entry.cols === cols && entry.rows === rows)) return null;
  const epoch = entry.geometryEpoch + 1;
  const previous = { cols: entry.cols, rows: entry.rows };
  try {
    entry.pty.resize(cols, rows);
    entry.headless.resize(cols, rows);
  } catch (error) {
    // Best-effort rollback keeps both terminal models on the retained
    // canonical dimensions; the original failure still rejects the caller.
    try {
      entry.pty.resize(previous.cols, previous.rows);
      entry.headless.resize(previous.cols, previous.rows);
    } catch (rollbackError) {
      console.error('[ptyHost] canonical resize rollback failed', rollbackError);
    }
    throw error;
  }
  entry.cols = cols;
  entry.rows = rows;
  entry.geometryEpoch = epoch;
  return { cols, rows, epoch };
}
```

Initialize `geometryEpoch: 0` in `makeEntry`; keep the existing default
`120 x 30` path and never reset retained dimensions on detach. Thread
`PtyInputOrigin` through `inputPtySession`; desktop IPC constructs
`{kind:'desktop-renderer', webContentsId:event.sender.id}`, and remote
`session.input` constructs `{kind:'mobile-control'}`. Change
`PtySessionInfo`/`AttachResult` and `sessions.list` catalog entries to include
`geometry: {cols, rows, epoch}` from `getCanonicalGeometry`; retain the existing
top-level `cols`/`rows` only on the desktop attach result until Task 4 updates
its renderer declaration.

- [ ] **Step 4: Remove the phone resize route and validate desktop sender identity**

```ts
ipcMain.handle(PTY_CHANNELS.resize, (event, sid, cols, rows) => {
  const mainWindow = deps.getMainWindow();
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id ||
    !validResize(sid, cols, rows)
  ) {
    return;
  }
  return deps.resizePtySession(sid, cols, rows, {
    kind: 'visible-desktop',
    webContentsId: event.sender.id,
  });
});
```

After JSON parsing, call Task 1's `isMobileClientMessage`; send the existing
`{type:'error', message:'invalid_message'}` response and return on failure.
Delete the `session.resize` branch from `handleClientMessage`. Add a raw runtime
test that passes `{type:'session.resize', ...}` and expects no
`resizePtySession` call and one `invalid_message` error response.
Update IPC tests so a matching `event.sender.id` forwards the explicit origin
and a different WebContents id is rejected.

- [ ] **Step 5: Run targeted tests and verify GREEN**

Run:

```bash
npx vitest run electron/ptyHost/__tests__/lifecycle.test.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts electron/remote/__tests__/remoteMessages.test.ts
```

Expected: PASS; only main-window desktop IPC can mutate canonical geometry,
and raw phone resize input cannot reach PTY lifecycle.

- [ ] **Step 6: Commit**

```bash
git add electron/ptyHost/entryFactory.ts electron/ptyHost/lifecycle.ts electron/ptyHost/index.ts electron/ptyHost/ipcRegistrar.ts electron/remote/remoteMessages.ts electron/ptyHost/__tests__/lifecycle.test.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts electron/remote/__tests__/remoteMessages.test.ts
git commit -m "feat(pty): enforce desktop canonical geometry"
```

### Task 3: Ordered Resize/Snapshot Barrier Coordinator

**Files:**
- Create: `electron/ptyHost/terminalSyncCoordinator.ts`
- Create: `electron/ptyHost/__tests__/terminalSyncCoordinator.test.ts`
- Modify: `electron/ptyHost/entryFactory.ts:64-99,150-220`
- Modify: `electron/ptyHost/lifecycle.ts:417-509`
- Modify: `electron/ptyHost/dataFanout.ts:10-38`
- Modify: `electron/ptyHost/index.ts:40-126`
- Modify: `electron/remote/ptyFanout.ts:1-12`
- Modify: `electron/remote/remoteMessages.ts:66-84`
- Modify: `electron/ptyHost/__tests__/bufferSnapshot.test.ts`
- Modify: `electron/ptyHost/__tests__/dataFanout.test.ts`
- Modify: `electron/remote/__tests__/ptyFanout.test.ts`
- Modify: `electron/remote/__tests__/remoteMessages.test.ts`

**Interfaces:**
- Consumes: Task 2 `resizeCanonicalGeometry`, `PtyResizeOrigin`, and existing PTY `seq`/headless write drain.
- Produces: `TerminalSyncPublication`,
  `enqueueChunkPublication(entry, sid, seq, chunk): void`,
  `commitResizeBarrier(registry, sid, cols, rows, origin): Promise<SessionSnapshotMessage | null>`,
  `getCoordinatedSnapshot(registry, sid): Promise<SessionSnapshotMessage | null>`,
  and `onTerminalSyncPublication(listener): () => void`.

- [ ] **Step 1: Write failing coordinator ordering tests**

```ts
it('publishes old chunk, one resize barrier, then new-epoch tail', async () => {
  const harness = createCoordinatorHarness({ cols: 120, rows: 30, epoch: 0 });

  harness.dispatch('old', 1);
  const barrierPromise = harness.resize(150, 40);
  harness.dispatch('during-redraw', 2);
  await barrierPromise;
  await harness.drain();

  expect(harness.publications).toEqual([
    { type: 'chunk', sid: 's1', seq: 1, chunk: 'old', geometryEpoch: 0 },
    expect.objectContaining({
      type: 'barrier',
      sid: 's1',
      geometry: { cols: 150, rows: 40, epoch: 1 },
    }),
    { type: 'chunk', sid: 's1', seq: 2, chunk: 'during-redraw', geometryEpoch: 1 },
  ]);
  expect(harness.publications.filter((event) => event.type === 'barrier')).toHaveLength(1);
});

it('serializes concurrent resize and snapshot requests onto the later complete epoch', async () => {
  const harness = createCoordinatorHarness();
  const resize = harness.resize(140, 35);
  const snapshot = harness.snapshot();
  const [barrier, response] = await Promise.all([resize, snapshot]);
  expect(response?.geometry.epoch).toBe(barrier?.geometry.epoch);
  expect(response?.seq).toBeGreaterThanOrEqual(barrier?.seq ?? -1);
});
```

Also cover no-op resize (no epoch/no barrier), two queued changed resizes (epochs
1 then 2), active headless writes completing during snapshot capture, and a
resize failure that rejects without publishing a barrier or incrementing the
epoch while the queue remains usable for a later old-epoch chunk.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run:

```bash
npx vitest run electron/ptyHost/__tests__/terminalSyncCoordinator.test.ts electron/ptyHost/__tests__/bufferSnapshot.test.ts electron/remote/__tests__/ptyFanout.test.ts
```

Expected: FAIL because there is no serialized sync publication queue or barrier event.

- [ ] **Step 3: Extract an entry-level atomic snapshot primitive**

```ts
export async function captureEntrySnapshot(entry: Entry): Promise<BufferSnapshot> {
  await waitForHeadlessWrites(entry);
  const seq = entry.seq;
  const snapshot = serializeHeadlessInChunks(entry);
  return { snapshot, seq };
}

export async function getBufferSnapshot(
  registry: Map<string, Entry>,
  sid: string,
): Promise<BufferSnapshot> {
  const entry = registry.get(sid);
  return entry ? captureEntrySnapshot(entry) : { snapshot: '', seq: 0 };
}
```

Move only the current write-drain and chunked serialization internals; retain
their existing timeout/backpressure behavior and tests.

- [ ] **Step 4: Implement one per-entry serialized publication chain**

```ts
function enqueue<T>(entry: Entry, operation: () => Promise<T> | T): Promise<T> {
  const result = entry.terminalSyncQueue.then(operation, operation);
  entry.terminalSyncQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function enqueueChunkPublication(
  entry: Entry,
  sid: string,
  seq: number,
  chunk: string,
): void {
  const geometryEpoch = entry.geometryEpoch;
  void enqueue(entry, () => {
    emitTerminalSyncPublication({ type: 'chunk', sid, seq, chunk, geometryEpoch });
  });
}

export function commitResizeBarrier(
  registry: Map<string, Entry>,
  sid: string,
  cols: number,
  rows: number,
  origin: PtyResizeOrigin,
): Promise<SessionSnapshotMessage | null> {
  const entry = registry.get(sid);
  if (!entry) return Promise.resolve(null);
  return enqueue(entry, async () => {
    const geometry = resizeCanonicalGeometry(registry, sid, cols, rows, origin);
    if (!geometry) return null;
    const { snapshot, seq } = await captureEntrySnapshot(entry);
    const message = { type: 'session.snapshot', sid, seq, snapshot, geometry } as const;
    emitTerminalSyncPublication({ type: 'barrier', sid, seq, snapshot, geometry });
    return message;
  });
}
```

Add `terminalSyncQueue: Promise<void>` to `Entry`. In `dispatchPtyChunk`, capture
the incremented `seq`, keep current headless/desktop IPC/notify sinks, and call
`enqueueChunkPublication` for the remote ordered stream. A chunk queued before a
resize captures the old epoch; a chunk dispatched after the queued resize starts
captures the incremented epoch and cannot publish until the barrier resolves.
`getCoordinatedSnapshot` uses the same `enqueue` function and returns current
`snapshot + seq + geometry`, so snapshot requests cannot cross an active barrier.

- [ ] **Step 5: Wire remote publication and coordinated snapshot responses**

```ts
export function installPtyFanout(peers: ReadonlySet<RemotePeer>): () => void {
  return onTerminalSyncPublication((publication) => {
    for (const peer of peers) {
      if (peer.subscribedSid !== publication.sid) continue;
      if (publication.type === 'chunk') {
        peer.send({
          type: 'pty.data',
          sid: publication.sid,
          seq: publication.seq,
          chunk: publication.chunk,
          geometryEpoch: publication.geometryEpoch,
        });
      } else {
        peer.send({
          type: 'session.snapshot',
          sid: publication.sid,
          seq: publication.seq,
          snapshot: publication.snapshot,
          geometry: publication.geometry,
        });
      }
    }
  });
}
```

`handleClientMessage({type:'session.snapshot'})` must set `peer.subscribedSid`
before awaiting `getCoordinatedSnapshot`, then send that complete result. Keep
the existing raw `onPtyData` stream unchanged for desktop notifications/OSC
consumers; only the encrypted remote fanout moves to the ordered sync stream.

- [ ] **Step 6: Run ordering tests and verify GREEN**

Run:

```bash
npx vitest run electron/ptyHost/__tests__/terminalSyncCoordinator.test.ts electron/ptyHost/__tests__/bufferSnapshot.test.ts electron/ptyHost/__tests__/dataFanout.test.ts electron/remote/__tests__/ptyFanout.test.ts electron/remote/__tests__/remoteMessages.test.ts
```

Expected: PASS with one barrier, strict old/barrier/new ordering, and no
pre-resize snapshot paired with post-resize dimensions.

- [ ] **Step 7: Commit**

```bash
git add electron/ptyHost/terminalSyncCoordinator.ts electron/ptyHost/__tests__/terminalSyncCoordinator.test.ts electron/ptyHost/entryFactory.ts electron/ptyHost/lifecycle.ts electron/ptyHost/dataFanout.ts electron/ptyHost/index.ts electron/remote/ptyFanout.ts electron/remote/remoteMessages.ts electron/ptyHost/__tests__/bufferSnapshot.test.ts electron/ptyHost/__tests__/dataFanout.test.ts electron/remote/__tests__/ptyFanout.test.ts electron/remote/__tests__/remoteMessages.test.ts
git commit -m "feat(pty): publish ordered resize barriers"
```

### Task 4: Visible Desktop Resize Ownership and Debounce

**Files:**
- Create: `src/terminal/visibleDesktopResize.ts`
- Create: `tests/terminal/visibleDesktopResize.test.ts`
- Modify: `src/terminal/usePtyAttachShell.ts:177-183,310-320,381-430`
- Modify: `src/terminal/shellRegistry.ts:237-287,425-456`
- Modify: `tests/terminal/shellRegistry.test.ts:184-195,316-339`
- Modify: `electron/preload/bridges/ccsmPty.ts:17-51`
- Modify: `electron/preload/bridges/__tests__/ccsmPty.test.ts`
- Modify: `src/pty.d.ts:9-80`
- Modify: `electron/ptyHost/ipcRegistrar.ts:180-244`
- Modify: `electron/ptyHost/__tests__/ipcRegistrar.test.ts:181-244`

**Interfaces:**
- Consumes: Task 3 async `resizePtySession(...): Promise<SessionSnapshotMessage | null>` through existing `PTY_CHANNELS.resize`.
- Produces:
  `scheduleVisibleDesktopResize(sid, cols, rows): void`,
  `commitVisibleDesktopResizeNow(sid, cols, rows): Promise<void>`,
  `cancelVisibleDesktopResize(sid): void`, and
  `VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS = 140`.

- [ ] **Step 1: Write failing visible-ownership/debounce tests**

```ts
it('coalesces continuous measurements into one commit at 140 ms', () => {
  vi.useFakeTimers();
  const resize = vi.fn().mockResolvedValue(undefined);
  const scheduler = createVisibleDesktopResizeScheduler({
    isVisible: (sid) => sid === 's1',
    resize,
  });
  scheduler.schedule('s1', 100, 30);
  scheduler.schedule('s1', 120, 34);
  scheduler.schedule('s1', 140, 38);
  vi.advanceTimersByTime(139);
  expect(resize).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(resize).toHaveBeenCalledOnce();
  expect(resize).toHaveBeenCalledWith('s1', 140, 38);
});

it('drops the pending commit when the shell is hidden before flush', () => {
  let visibleSid: string | null = 's1';
  const resize = vi.fn().mockResolvedValue(undefined);
  const scheduler = createVisibleDesktopResizeScheduler({
    isVisible: (sid) => sid === visibleSid,
    resize,
  });
  scheduler.schedule('s1', 120, 34);
  visibleSid = 's2';
  vi.advanceTimersByTime(140);
  expect(resize).not.toHaveBeenCalled();
});
```

Add cases for unmounted/cancelled shell, invalid/no-layout dimensions, unchanged
measurement, immediate first visible attach, and hidden font-size updates.

- [ ] **Step 2: Run desktop tests and verify RED**

Run:

```bash
npx vitest run tests/terminal/visibleDesktopResize.test.ts tests/terminal/shellRegistry.test.ts electron/preload/bridges/__tests__/ccsmPty.test.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts
```

Expected: FAIL because resize calls are distributed and the observer uses 80 ms.

- [ ] **Step 3: Implement the central visible resize scheduler**

```ts
export const VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS = 140;

export type VisibleDesktopResizeScheduler = {
  schedule(sid: string, cols: number, rows: number): void;
  commitNow(sid: string, cols: number, rows: number): Promise<void>;
  cancel(sid: string): void;
  dispose(): void;
};

type PendingResize = {
  sid: string;
  cols: number;
  rows: number;
  timer: ReturnType<typeof setTimeout>;
};

export function createVisibleDesktopResizeScheduler(deps: {
  isVisible(sid: string): boolean;
  resize(sid: string, cols: number, rows: number): Promise<void>;
}): VisibleDesktopResizeScheduler {
  let pending: PendingResize | null = null;
  let lastCommitted: { sid: string; cols: number; rows: number } | null = null;
  const commit = async (sid: string, cols: number, rows: number): Promise<void> => {
    if (!deps.isVisible(sid)) return;
    if (
      lastCommitted?.sid === sid &&
      lastCommitted.cols === cols &&
      lastCommitted.rows === rows
    ) return;
    await deps.resize(sid, cols, rows);
    lastCommitted = { sid, cols, rows };
  };
  return {
    schedule(sid, cols, rows) {
      if (pending) clearTimeout(pending.timer);
      const timer = setTimeout(() => {
        pending = null;
        void commit(sid, cols, rows);
      }, VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS);
      pending = { sid, cols, rows, timer };
    },
    commitNow: commit,
    cancel(sid) {
      if (pending?.sid !== sid) return;
      clearTimeout(pending.timer);
      pending = null;
    },
    dispose() {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    },
  };
}
```

Add finite/integer/range validation before scheduling or committing. Construct
one scheduler in `shellRegistry.ts` with
`isVisible: (sid) => getTopSid() === sid` and
`resize: window.ccsmPty.resize`; export the three locked wrapper functions
`scheduleVisibleDesktopResize`, `commitVisibleDesktopResizeNow`, and
`cancelVisibleDesktopResize` from `shellRegistry.ts`. This avoids an import
cycle between the pure scheduler module and the shell registry. Use immediate
commit for first visible attach/reveal and schedule only for `ResizeObserver`
drag measurements. Cancel on terminal unmount, shell disposal, or visibility
change.

- [ ] **Step 4: Replace every desktop resize caller with the authority helper**

In `usePtyAttachShell.ts`, remove its local 80 ms timer. Cold attach and
already-visited attach call `commitVisibleDesktopResizeNow` only after the shell
is top/visible. `ResizeObserver` calls `scheduleVisibleDesktopResize`.
In `shellRegistry.ts`, `showShell` may immediately commit the newly visible
shell after applying pending font size; `applyTerminalFontSize` may resize only
`getTopShell()`, while hidden shells retain `pendingFontSize`.

Keep the preload method shape:

```ts
resize: (sid: string, cols: number, rows: number): Promise<void> =>
  ipcRenderer.invoke(PTY_CHANNELS.resize, sid, cols, rows),
```

Update main IPC to await Task 3's async barrier without exposing the origin to
renderer arguments or returning the snapshot payload:

```ts
await deps.resizePtySession(sid, cols, rows, {
  kind: 'visible-desktop',
  webContentsId: event.sender.id,
});
return undefined;
```

Update `src/pty.d.ts` attach and buffer snapshot results with
`geometry: TerminalGeometry`.

- [ ] **Step 5: Run desktop tests and verify GREEN**

Run:

```bash
npx vitest run tests/terminal/visibleDesktopResize.test.ts tests/terminal/shellRegistry.test.ts electron/preload/bridges/__tests__/ccsmPty.test.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts
```

Expected: PASS; continuous drag creates one delayed commit, hidden/unmounted
shells create none, and initial visible attach remains immediate.

- [ ] **Step 6: Commit**

```bash
git add src/terminal/visibleDesktopResize.ts tests/terminal/visibleDesktopResize.test.ts src/terminal/usePtyAttachShell.ts src/terminal/shellRegistry.ts tests/terminal/shellRegistry.test.ts electron/preload/bridges/ccsmPty.ts electron/preload/bridges/__tests__/ccsmPty.test.ts src/pty.d.ts electron/ptyHost/ipcRegistrar.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts
git commit -m "feat(terminal): debounce visible desktop resize"
```

### Task 5: Geometry-Aware Phone Terminal Synchronization

**Files:**
- Modify: `src/mobile/terminalSync.ts:1-161`
- Modify: `tests/mobile/terminalSync.test.ts`
- Modify: `src/mobile/mobileRemoteStore.ts:27-81,383-492`
- Modify: `tests/mobile/mobileRemoteStore.test.ts:1065-1209,1263-1279`
- Modify: `src/mobile/testBridge.d.ts`

**Interfaces:**
- Consumes: Task 1 `SessionSnapshotMessage`, `PtyDataMessage`, `TerminalGeometry`; existing `MAX_BUFFERED_TERMINAL_CHUNKS = 256`.
- Produces:
  `TerminalSyncRecoveryReason`,
  geometry-aware `TerminalSyncState`,
  `TerminalSyncEffect`,
  `installSnapshot` render effect, and session-tagged `TerminalRenderBatch`.

```ts
export type TerminalSyncRecoveryReason =
  | 'initial'
  | 'sequence-gap'
  | 'future-geometry'
  | 'buffer-overflow';

export type TerminalSyncEffect =
  | {
      type: 'installSnapshot';
      sid: string;
      seq: number;
      snapshot: string;
      geometry: TerminalGeometry;
    }
  | { type: 'write'; sid: string; seq: number; data: string }
  | { type: 'requestSnapshot'; sid: string; reason: TerminalSyncRecoveryReason };

export type TerminalSyncState = {
  sid: string | null;
  phase: 'idle' | 'syncing' | 'live';
  geometry: TerminalGeometry | null;
  lastSeq: number;
  buffered: Map<number, PtyDataMessage>;
  snapshotRequested: boolean;
  recoveryReason: TerminalSyncRecoveryReason | null;
};
```

- [ ] **Step 1: Replace reducer tests with a complete geometry epoch matrix**

```ts
function chunk(
  seq: number,
  geometryEpoch: number,
  data: string,
  sid = 's1',
): PtyDataMessage {
  return { type: 'pty.data', sid, seq, chunk: data, geometryEpoch };
}

function snapshot(
  seq: number,
  geometry: TerminalGeometry,
  data: string,
  sid = 's1',
): SessionSnapshotMessage {
  return { type: 'session.snapshot', sid, seq, snapshot: data, geometry };
}

function syncedState(geometry: TerminalGeometry, lastSeq: number): TerminalSyncState {
  return {
    sid: 's1',
    phase: 'live',
    geometry,
    lastSeq,
    buffered: new Map(),
    snapshotRequested: false,
    recoveryReason: null,
  };
}

it('installs a future-epoch barrier once and drains only its contiguous tail', () => {
  let state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
  state = applyTerminalChunk(state, chunk(12, 3, 'tail-12')).state;
  state = applyTerminalChunk(state, chunk(11, 3, 'tail-11')).state;

  const result = applyTerminalSnapshot(
    state,
    snapshot(10, { cols: 150, rows: 40, epoch: 3 }, 'screen-v3'),
  );

  expect(result.effects).toEqual([
    {
      type: 'installSnapshot',
      sid: 's1',
      seq: 10,
      snapshot: 'screen-v3',
      geometry: { cols: 150, rows: 40, epoch: 3 },
    },
    { type: 'write', sid: 's1', seq: 11, data: 'tail-11' },
    { type: 'write', sid: 's1', seq: 12, data: 'tail-12' },
  ]);
  expect(result.state).toMatchObject({ phase: 'live', lastSeq: 12 });
});

it.each([
  ['stale epoch', chunk(11, 1, 'stale')],
  ['duplicate seq', chunk(10, 2, 'duplicate')],
])('ignores %s without recovery', (_label, message) => {
  const result = applyTerminalChunk(
    syncedState({ cols: 120, rows: 30, epoch: 2 }, 10),
    message,
  );
  expect(result.effects).toEqual([]);
});
```

Add explicit cases for: wrong sid; same-epoch contiguous write; same-epoch gap;
future epoch; stale barrier; superseded barrier; future barrier with stale seq;
snapshot/live overlap; unordered buffered tail; exactly 256 buffered chunks;
257th chunk overflow; one recovery request while already syncing; reconnect and
session reset.

- [ ] **Step 2: Run reducer/store tests and verify RED**

Run:

```bash
npx vitest run tests/mobile/terminalSync.test.ts tests/mobile/mobileRemoteStore.test.ts
```

Expected: FAIL because state/effects do not carry geometry epochs and snapshots
currently emit only `reset`.

- [ ] **Step 3: Implement strict epoch plus sequence transitions**

```ts
function requestRecovery(
  state: TerminalSyncState,
  reason: TerminalSyncRecoveryReason,
): TerminalSyncResult {
  if (!state.sid || state.snapshotRequested) {
    return { state: { ...state, phase: 'syncing', recoveryReason: reason }, effects: [] };
  }
  return {
    state: {
      ...state,
      phase: 'syncing',
      snapshotRequested: true,
      recoveryReason: reason,
    },
    effects: [{ type: 'requestSnapshot', sid: state.sid, reason }],
  };
}

export function applyTerminalChunk(
  state: TerminalSyncState,
  message: PtyDataMessage,
): TerminalSyncResult {
  if (!state.sid || message.sid !== state.sid) return unchanged(state);
  if (!state.geometry) return bufferWhileSyncing(state, message, 'initial');
  if (message.geometryEpoch < state.geometry.epoch || message.seq <= state.lastSeq) {
    return unchanged(state);
  }
  if (message.geometryEpoch > state.geometry.epoch) {
    return bufferWhileSyncing(state, message, 'future-geometry');
  }
  if (state.phase === 'live' && message.seq === state.lastSeq + 1) {
    return {
      state: { ...state, lastSeq: message.seq },
      effects: [{ type: 'write', sid: message.sid, seq: message.seq, data: message.chunk }],
    };
  }
  return bufferWhileSyncing(state, message, 'sequence-gap');
}
```

Define the two reducer-local helpers with these exact signatures:

```ts
function unchanged(state: TerminalSyncState): TerminalSyncResult {
  return { state, effects: [] };
}

function bufferWhileSyncing(
  state: TerminalSyncState,
  message: PtyDataMessage,
  reason: TerminalSyncRecoveryReason,
): TerminalSyncResult {
  if (state.buffered.size >= MAX_BUFFERED_TERMINAL_CHUNKS) {
    return requestRecovery({ ...state, buffered: new Map() }, 'buffer-overflow');
  }
  const buffered = new Map(state.buffered);
  buffered.set(message.seq, message);
  return requestRecovery({ ...state, buffered }, reason);
}
```

`applyTerminalSnapshot` must reject wrong sid, lower epoch, or same-epoch
snapshot `seq <= lastSeq`; install a valid current/later epoch; discard buffered
chunks covered by its sequence or from other epochs; drain only contiguous
matching-epoch chunks; and remain syncing with one snapshot request if a gap
remains. On overflow, clear the unsafe buffered set, retain the last installed
geometry/frame state, mark `buffer-overflow`, and request one snapshot.

- [ ] **Step 4: Carry atomic install effects through the store**

```ts
export type TerminalRenderBatch = {
  id: number;
  sid: string;
  effects: Array<
    Extract<TerminalSyncEffect, { type: 'installSnapshot' | 'write' }>
  >;
};
```

Filter `installSnapshot | write` as render effects. Merge an unconsumed batch
only when `state.terminalBatch.sid === result.state.sid`; otherwise replace it.
Keep recovery requests fire-and-forget and exactly one per reducer effect.
Expose `geometryEpoch` and `recoveryReason` in the JSON-safe test bridge, never
pairing data, drafts, keys, or raw encrypted frames.

- [ ] **Step 5: Run reducer/store tests and verify GREEN**

Run:

```bash
npx vitest run tests/mobile/terminalSync.test.ts tests/mobile/mobileRemoteStore.test.ts
```

Expected: PASS across stale/future/overlap/gap/overflow/reconnect/session-switch
cases with the 256-chunk bound unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/mobile/terminalSync.ts tests/mobile/terminalSync.test.ts src/mobile/mobileRemoteStore.ts tests/mobile/mobileRemoteStore.test.ts src/mobile/testBridge.d.ts
git commit -m "feat(mobile): sync terminal geometry epochs"
```

### Task 6: Canonical Mobile Xterm Adapter and Physical Viewport API

**Files:**
- Modify: `src/mobile/mobileTerminalAdapter.ts:27-296`
- Modify: `tests/mobile/mobileTerminalAdapter.test.ts`

**Interfaces:**
- Consumes: Task 5 `installSnapshot | write` effects and `TerminalViewportAnchor` defined in the code map.
- Produces:
  `TerminalScrollMetrics`,
  `TerminalViewportState`,
  and the final `MobileTerminalAdapter` API:

```ts
export type TerminalViewportState = {
  geometry: TerminalGeometry | null;
  contentWidthPx: number;
  scroll: TerminalScrollMetrics;
};

export type RenderTerminalEffect = Extract<
  TerminalSyncEffect,
  { type: 'installSnapshot' | 'write' }
>;

export type MobileTerminalAdapter = {
  apply(
    effects: readonly Extract<TerminalSyncEffect, { type: 'installSnapshot' | 'write' }>[],
    anchor?: TerminalViewportAnchor,
  ): void;
  captureAnchor(horizontalOffsetPx: number): TerminalViewportAnchor;
  getViewportState(): TerminalViewportState;
  subscribeViewport(listener: (state: TerminalViewportState) => void): () => void;
  scrollToLine(line: number): void;
  scrollLines(lines: number): void;
  copySelection(): Promise<void>;
  serialize(): string;
  dispose(): void;
};
```

- [ ] **Step 1: Write failing adapter geometry/viewport tests**

```ts
function install(geometry: TerminalGeometry, snapshot: string): RenderTerminalEffect {
  return {
    type: 'installSnapshot',
    sid: 's1',
    seq: 1,
    snapshot,
    geometry,
  };
}

it('resizes xterm only from an installSnapshot effect', () => {
  const { adapter, terminal } = createHarness();
  adapter.apply([install({ cols: 132, rows: 36, epoch: 2 }, 'screen')]);
  expect(terminal.resize).toHaveBeenCalledOnce();
  expect(terminal.resize).toHaveBeenCalledWith(132, 36);

  window.dispatchEvent(new Event('resize'));
  visualViewport.dispatchEvent(new Event('resize'));
  vi.runAllTimers();
  expect(terminal.resize).toHaveBeenCalledOnce();
});

it('reports xterm logical scroll metrics and clamps public scroll actions', () => {
  const { adapter, terminal } = createHarness({
    buffer: { active: { baseY: 200, viewportY: 150 } },
    rows: 30,
  });
  expect(adapter.getViewportState().scroll).toEqual({
    maximumTop: 200,
    currentTop: 150,
    visibleRows: 30,
  });
  adapter.scrollToLine(999);
  expect(terminal.scrollToLine).toHaveBeenCalledWith(200);
});
```

Add tests that `visualViewport`, keyboard simulation, rotation, zoom, and local
host width change only CSS viewport variables/metrics; `FitAddon` and
`onResize` are gone; no `onData`, terminal focus, textarea focus/blur, or helper
focus occurs; selection copy stays native; install then tail has exactly one
resize/reset; content width is measured from the rendered `.xterm-screen`;
horizontal offsets are preserved for equal `canonicalCols` and clamped by the
React viewport later.

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
npx vitest run tests/mobile/mobileTerminalAdapter.test.ts
```

Expected: FAIL because current `fit()` resizes xterm from phone dimensions and
emits `onResize`.

- [ ] **Step 3: Replace fit semantics with canonical install semantics**

```ts
function apply(
  effects: readonly RenderTerminalEffect[],
  suppliedAnchor?: TerminalViewportAnchor,
): void {
  const anchor = suppliedAnchor ?? captureAnchor(0);
  for (const effect of effects) {
    if (effect.type === 'installSnapshot') {
      geometry = effect.geometry;
      terminal.resize(effect.geometry.cols, effect.geometry.rows);
      terminal.reset();
      terminal.write(effect.snapshot, () => {
        restoreVerticalAnchor(anchor);
        publishViewport();
      });
    } else {
      const beforeWrite = captureAnchor(anchor.horizontalOffsetPx);
      terminal.write(effect.data, () => {
        restoreVerticalAnchor(beforeWrite);
        publishViewport();
      });
    }
  }
}
```

Remove `FitAddon`, `MobileTerminalDimensions`, `onResize`, `fit()`, and all
phone-dimension calls to `terminal.resize`. Keep `syncViewportMetrics`, but it
only writes `--app-height`/`--app-offset-top` and schedules
`publishViewport()`. Extend `MobileXtermTerminal` with:

```ts
readonly buffer: { active: { baseY: number; viewportY: number } };
scrollToLine(line: number): void;
scrollLines(amount: number): void;
onScroll(listener: (position: number) => void): { dispose(): void };
```

Calculate `contentWidthPx` from `.xterm-screen.getBoundingClientRect().width`
after write/resize and on physical viewport changes. Notify subscribers on
xterm scroll, write completion, canonical install, and physical resize.
`captureAnchor` uses `baseY - viewportY`; `restoreVerticalAnchor` calls
`scrollToLine(baseY)` for bottom mode or
`scrollToLine(clamp(baseY - distanceFromBottom, 0, baseY))` for history mode.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run:

```bash
npx vitest run tests/mobile/mobileTerminalAdapter.test.ts
```

Expected: PASS; only authoritative install effects resize logical xterm, and
all physical phone changes leave PTY geometry untouched.

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobileTerminalAdapter.ts tests/mobile/mobileTerminalAdapter.test.ts
git commit -m "feat(mobile): separate xterm grid from viewport"
```

### Task 7: Persistent Accessible Mobile Terminal Scrollbar

**Files:**
- Create: `src/mobile/terminalScrollMetrics.ts`
- Create: `src/mobile/components/MobileTerminalScrollbar.tsx`
- Create: `tests/mobile/terminalScrollMetrics.test.ts`
- Create: `tests/mobile/MobileTerminalScrollbar.test.tsx`

**Interfaces:**
- Consumes: Task 6 `TerminalScrollMetrics`, `scrollToLine`, and `scrollLines`.
- Produces:

```ts
export type ScrollbarGeometry = {
  disabled: boolean;
  maximumTop: number;
  thumbHeightPx: number;
  thumbOffsetPx: number;
  travelPx: number;
};

export function calculateScrollbarGeometry(
  metrics: TerminalScrollMetrics,
  trackHeightPx: number,
  minimumThumbPx?: number,
): ScrollbarGeometry;

export function lineForTrackOffset(
  offsetPx: number,
  geometry: ScrollbarGeometry,
): number;

export type MobileTerminalScrollbarProps = {
  terminalId: string;
  metrics: TerminalScrollMetrics;
  onScrollToLine(line: number): void;
  onScrollLines(lines: number): void;
};
```

- [ ] **Step 1: Write failing pure metric tests**

```ts
it('renders a disabled full-height thumb with no scrollback', () => {
  expect(calculateScrollbarGeometry(
    { maximumTop: 0, currentTop: 0, visibleRows: 30 },
    300,
  )).toEqual({
    disabled: true,
    maximumTop: 0,
    thumbHeightPx: 300,
    thumbOffsetPx: 0,
    travelPx: 0,
  });
});

it('enforces a 44 px thumb and maps the full track to logical lines', () => {
  const geometry = calculateScrollbarGeometry(
    { maximumTop: 970, currentTop: 485, visibleRows: 30 },
    220,
  );
  expect(geometry.thumbHeightPx).toBeGreaterThanOrEqual(44);
  expect(lineForTrackOffset(0, geometry)).toBe(0);
  expect(lineForTrackOffset(220, geometry)).toBe(970);
});
```

- [ ] **Step 2: Write failing component interaction/a11y tests**

```tsx
it('captures pointer drag, jumps on track click, and never focuses xterm', () => {
  const onScrollToLine = vi.fn();
  render(
    <MobileTerminalScrollbar
      terminalId="phone-terminal-output"
      metrics={{ maximumTop: 100, currentTop: 20, visibleRows: 25 }}
      onScrollToLine={onScrollToLine}
      onScrollLines={vi.fn()}
    />,
  );
  const rail = screen.getByRole('scrollbar', { name: /terminal output/i });
  fireEvent.pointerDown(rail, { pointerId: 3, clientY: 180 });
  expect(rail.setPointerCapture).toHaveBeenCalledWith(3);
  expect(onScrollToLine).toHaveBeenCalled();
  expect(document.activeElement).not.toHaveClass('xterm-helper-textarea');
});
```

Add keyboard assertions for Arrow Up/Down, Page Up/Down, Home, End; ARIA
`orientation`, `valuemin=0`, `valuemax=maximumTop`, `valuenow=currentTop`,
`aria-controls`; disabled state; pointer cancel/release; browser zoom fractional
track sizes; and click-on-thumb beginning drag rather than jumping.

- [ ] **Step 3: Run scrollbar tests and verify RED**

Run:

```bash
npx vitest run tests/mobile/terminalScrollMetrics.test.ts tests/mobile/MobileTerminalScrollbar.test.tsx
```

Expected: FAIL because the helper and component do not exist.

- [ ] **Step 4: Implement pure projection and pointer/keyboard behavior**

```ts
export function calculateScrollbarGeometry(
  metrics: TerminalScrollMetrics,
  trackHeightPx: number,
  minimumThumbPx = 44,
): ScrollbarGeometry {
  const track = Math.max(0, trackHeightPx);
  const maximumTop = Math.max(0, metrics.maximumTop);
  if (maximumTop === 0 || track === 0) {
    return {
      disabled: true,
      maximumTop,
      thumbHeightPx: track,
      thumbOffsetPx: 0,
      travelPx: 0,
    };
  }
  const totalRows = maximumTop + Math.max(1, metrics.visibleRows);
  const thumbHeightPx = Math.min(
    track,
    Math.max(minimumThumbPx, track * metrics.visibleRows / totalRows),
  );
  const travelPx = track - thumbHeightPx;
  const currentTop = Math.min(maximumTop, Math.max(0, metrics.currentTop));
  return {
    disabled: false,
    maximumTop,
    thumbHeightPx,
    thumbOffsetPx: travelPx * currentTop / maximumTop,
    travelPx,
  };
}

export function lineForTrackOffset(
  pointerOffsetPx: number,
  geometry: ScrollbarGeometry,
): number {
  if (geometry.disabled || geometry.travelPx <= 0) return 0;
  const desiredThumbTop = pointerOffsetPx - geometry.thumbHeightPx / 2;
  const clampedThumbTop = Math.min(
    geometry.travelPx,
    Math.max(0, desiredThumbTop),
  );
  return Math.round(
    geometry.maximumTop * clampedThumbTop / geometry.travelPx,
  );
}
```

Implement the React component with a measured rail `ResizeObserver`, a
roughly 24 px focusable rail, pointer capture, drag-start offset, clamped track
mapping, `aria-label="Terminal output scroll position"`,
`aria-disabled={geometry.disabled}`, and exact keyboard mapping:

```ts
const KEY_LINES: Record<string, number> = {
  ArrowUp: -1,
  ArrowDown: 1,
  PageUp: -metrics.visibleRows,
  PageDown: metrics.visibleRows,
};
```

Home calls `onScrollToLine(0)` and End calls
`onScrollToLine(metrics.maximumTop)`. Event handlers call `preventDefault` and
`stopPropagation`; they never query or focus the terminal/helper textarea.
During thumb drag, convert the grabbed thumb top to a synthetic centered
pointer offset before calling `lineForTrackOffset`, so the thumb does not jump
under the finger.

- [ ] **Step 5: Run scrollbar tests and verify GREEN**

Run:

```bash
npx vitest run tests/mobile/terminalScrollMetrics.test.ts tests/mobile/MobileTerminalScrollbar.test.tsx
```

Expected: PASS for metrics, minimum thumb, pointer capture/drag, track jump,
keyboard controls, ARIA, disabled state, and no xterm focus.

- [ ] **Step 6: Commit**

```bash
git add src/mobile/terminalScrollMetrics.ts src/mobile/components/MobileTerminalScrollbar.tsx tests/mobile/terminalScrollMetrics.test.ts tests/mobile/MobileTerminalScrollbar.test.tsx
git commit -m "feat(mobile): add terminal scrollbar"
```

### Task 8: Phone Shell Viewport, Session Anchors, and CSS Integration

**Files:**
- Modify: `src/mobile/components/MobileTerminal.tsx:24-80`
- Modify: `src/mobile/components/PhoneShell.tsx:30-167,267-273`
- Modify: `src/mobile/mobileRemoteStore.ts:27-31,469-492`
- Modify: `src/mobile/mobile.css:205-219`
- Modify: `electron/remote/mobilePage.ts:92-103,125-167`
- Modify: `tests/mobile/MobileTerminal.test.tsx`
- Modify: `tests/mobile/PhoneShell.test.tsx:751-829`
- Modify: `tests/mobile/mobileRemoteStore.test.ts:1079-1137`
- Modify: `tests/mobile/mobileCss.test.ts`
- Create: `electron/remote/__tests__/mobilePage.test.ts`

**Interfaces:**
- Consumes: Task 5 session-tagged batches, Task 6 adapter viewport API, Task 7 scrollbar.
- Produces: `MobileTerminalProps` with `sid`, one horizontal scroll container,
  per-session `Map<string, TerminalViewportAnchor>`, persistent vertical rail,
  and no phone resize callback.

- [ ] **Step 1: Write failing wrapper/shell integration tests**

```tsx
function installV1(
  sid: string,
): Extract<TerminalSyncEffect, { type: 'installSnapshot' }> {
  return {
    type: 'installSnapshot',
    sid,
    seq: 0,
    snapshot: 'screen',
    geometry: { cols: 140, rows: 30, epoch: 1 },
  };
}

function batch(
  id: number,
  sid: string,
  effects: TerminalRenderBatch['effects'],
): TerminalRenderBatch {
  return { id, sid, effects: [...effects] };
}

it('preserves a history anchor per session and restores it after switching back', () => {
  const adapter = createFakeAdapter();
  const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
  const adapterRef = createRef();
  const props = {
    onConsumed: vi.fn(),
    adapterRef,
    createAdapter,
  };
  const { rerender } = render(
    <MobileTerminal {...props} sid="s1" batch={null} />,
  );
  vi.mocked(adapter.captureAnchor).mockReturnValue({
    mode: 'history',
    distanceFromBottom: 18,
    horizontalOffsetPx: 76,
    canonicalCols: 140,
  });

  rerender(<MobileTerminal {...props} sid="s2" batch={batch(1, 's2', [installV1('s2')])} />);
  rerender(<MobileTerminal {...props} sid="s1" batch={batch(2, 's1', [installV1('s1')])} />);

  expect(adapter.apply).toHaveBeenLastCalledWith(
    expect.any(Array),
    expect.objectContaining({ mode: 'history', distanceFromBottom: 18 }),
  );
});

it('never sends session.resize for viewport, keyboard, orientation, or session switch', async () => {
  const client = createFakeClient();
  const { factory, adapters } = createFakeAdapterFactory();
  render(<PhoneShell client={client} createAdapter={factory} />);
  client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
  client.emitStatus('connected');
  window.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('orientationchange'));
  adapters[0]!.emitViewport({
    geometry: { cols: 140, rows: 30, epoch: 1 },
    contentWidthPx: 1120,
    scroll: { maximumTop: 10, currentTop: 10, visibleRows: 30 },
  });
  expect(client.sent.some((message) => message.type === 'session.resize')).toBe(false);
});
```

Update the test-local fake adapter with a subscriber set and an `emitViewport`
test seam:

```ts
type FakeMobileTerminalAdapter = MobileTerminalAdapter & {
  emitViewport(state: TerminalViewportState): void;
};

function createFakeAdapter(): FakeMobileTerminalAdapter {
  const listeners = new Set<(state: TerminalViewportState) => void>();
  return {
    apply: vi.fn(),
    captureAnchor: vi.fn(() => ({
      mode: 'bottom',
      horizontalOffsetPx: 0,
      canonicalCols: 140,
    })),
    getViewportState: vi.fn(() => ({
      geometry: null,
      contentWidthPx: 0,
      scroll: { maximumTop: 0, currentTop: 0, visibleRows: 30 },
    })),
    subscribeViewport: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    scrollToLine: vi.fn(),
    scrollLines: vi.fn(),
    copySelection: vi.fn().mockResolvedValue(undefined),
    serialize: vi.fn(() => ''),
    dispose: vi.fn(),
    emitViewport(state) {
      for (const listener of listeners) listener(state);
    },
  };
}
```

Create `electron/remote/__tests__/mobilePage.test.ts` with the legacy sender
contract:

```ts
import { describe, expect, it } from 'vitest';
import { renderMobilePage } from '../mobilePage';

describe('renderMobilePage terminal ownership', () => {
  it('keeps viewport changes local and never emits session.resize', () => {
    const html = renderMobilePage();
    expect(html).not.toContain("type: 'session.resize'");
    expect(html).not.toContain('lastSentCols');
    expect(html).not.toContain('lastSentRows');
  });
});
```

Add wrapper cases for: one adapter across rerenders; at-bottom follows output;
history distance survives live writes and barriers; reconnect same sid; no
saved anchor starts bottom; horizontal offset preserved for equal column count;
horizontal offset clamped after narrower extent/session/orientation/keyboard;
native terminal pointer selection reaches xterm; copy succeeds; rail pointer
actions do not focus helper/composer; batch consumed once after successful
apply; scrollbar metrics update on adapter subscription.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
npx vitest run tests/mobile/MobileTerminal.test.tsx tests/mobile/PhoneShell.test.tsx tests/mobile/mobileRemoteStore.test.ts tests/mobile/mobileCss.test.ts electron/remote/__tests__/mobilePage.test.ts
```

Expected: FAIL because `onResize`/`fit(true)` still send phone geometry and the
legacy page still emits `session.resize`; the viewport/scrollbar/anchor
composition does not exist.

- [ ] **Step 3: Compose the adapter inside an independent physical viewport**

```tsx
export type MobileTerminalProps = {
  sid: string | null;
  batch: TerminalRenderBatch | null;
  onConsumed(id: number): void;
  adapterRef: MutableRefObject<MobileTerminalAdapter | null>;
  createAdapter?: MobileTerminalAdapterFactory;
};

return (
  <div className="mobile-terminal" aria-label="Terminal viewport">
    <div
      ref={viewportRef}
      className="mobile-terminal__viewport"
      onScroll={captureHorizontalOffset}
    >
      <div
        id="phone-terminal-output"
        ref={hostRef}
        className="mobile-terminal__grid"
        aria-label="Terminal output"
        style={{ width: `${viewportState.contentWidthPx}px` }}
      />
    </div>
    <MobileTerminalScrollbar
      terminalId="phone-terminal-output"
      metrics={viewportState.scroll}
      onScrollToLine={(line) => adapterRef.current?.scrollToLine(line)}
      onScrollLines={(lines) => adapterRef.current?.scrollLines(lines)}
    />
  </div>
);
```

Declare layout effects in this order: create adapter; subscribe viewport;
capture previous sid anchor when `sid` changes; apply numbered batch with the
saved/current anchor; consume only after `apply` returns. Keep one
`Map<string, TerminalViewportAnchor>` for the component lifetime. Set/clamp
`viewportRef.current.scrollLeft` after metric changes; preserve it when
`canonicalCols` is unchanged.

- [ ] **Step 4: Remove phone resize transmission and pass session identity**

Delete `handleResize`, the selected-session `adapter.fit(true)` effect, and
`onResize` prop from `PhoneShell`. Render:

```tsx
<MobileTerminal
  sid={state.selectedSessionId}
  batch={state.terminalBatch}
  onConsumed={handleConsumed}
  adapterRef={adapterRef}
  createAdapter={createAdapter}
/>
```

Update all fake adapter factories to implement Task 6's API. Ensure test
clients' recovery classification contains only `sessions.list` and
`session.snapshot`.

In `renderMobilePage`, delete `lastSentCols`, `lastSentRows`, and only the
outgoing `send({ type: 'session.resize', ... })` branch. Keep
`visualViewport`, orientation, and keyboard layout listeners as physical
viewport concerns. Do not copy its local FitAddon dimensions into the React
adapter, protocol snapshot, desktop/headless reference, or canonical session
state.

- [ ] **Step 5: Add final viewport/rail CSS**

```css
.mobile-terminal {
  grid-area: terminal;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 24px;
  overflow: hidden;
  background: #000;
}

.mobile-terminal__viewport {
  min-width: 0;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior: contain;
  touch-action: pan-x pan-y;
  scrollbar-width: none;
}

.mobile-terminal__viewport::-webkit-scrollbar {
  display: none;
}

.mobile-terminal__grid {
  min-height: 100%;
  user-select: text;
  -webkit-user-select: text;
}

.mobile-terminal-scrollbar {
  width: 24px;
  min-width: 24px;
  touch-action: none;
}

.mobile-terminal-scrollbar__thumb {
  min-height: 44px;
}

@media (forced-colors: active) {
  .mobile-terminal-scrollbar {
    border-left: 1px solid CanvasText;
  }
  .mobile-terminal-scrollbar__thumb {
    background: Highlight;
    forced-color-adjust: none;
  }
}
```

Hide only the native vertical scrollbar; retain native touch pan and text
selection. Add a subtle left-edge shadow/gradient when `scrollLeft > 0` or
horizontal overflow exists, with `aria-hidden` visual affordance and no focus
target.

- [ ] **Step 6: Run integration tests and verify GREEN**

Run:

```bash
npx vitest run tests/mobile/MobileTerminal.test.tsx tests/mobile/PhoneShell.test.tsx tests/mobile/mobileRemoteStore.test.ts tests/mobile/mobileCss.test.ts electron/remote/__tests__/mobilePage.test.ts
```

Expected: PASS for session/reconnect anchors, horizontal clamping, persistent
scrollbar, native selection/copy, no focus transfer, and zero React or legacy
phone PTY resize.

- [ ] **Step 7: Commit**

```bash
git add src/mobile/components/MobileTerminal.tsx src/mobile/components/PhoneShell.tsx src/mobile/mobileRemoteStore.ts src/mobile/mobile.css electron/remote/mobilePage.ts tests/mobile/MobileTerminal.test.tsx tests/mobile/PhoneShell.test.tsx tests/mobile/mobileRemoteStore.test.ts tests/mobile/mobileCss.test.ts electron/remote/__tests__/mobilePage.test.ts
git commit -m "feat(mobile): integrate independent terminal viewport"
```

### Task 9: Deterministic Geometry Fault and Visual E2E Harnesses

**Files:**
- Modify: `scripts/probe-helpers/mobileRemoteHarness.mjs:215-490`
- Modify: `scripts/harness-e2e-mobile-terminal-sync.mjs:1-600`
- Modify: `scripts/harness-e2e-mobile-remote-relay.mjs`
- Modify: `scripts/harness-e2e-mobile-remote-visual.mjs:1-302`
- Modify: `scripts/fixtures/mobile-remote-pty-fixture.mjs`
- Modify: `scripts/run-all-e2e.mjs:1-18`

**Interfaces:**
- Consumes: Protocol v2, Task 3 barrier contract, Task 8 DOM/test bridge.
- Produces simulated desktop APIs:

```js
get receivedMessages()
sendPty(sid, seq, chunk, geometryEpoch)
sendRawPty(sid, seq, chunk, geometryEpoch)
sendInFlightPty(sid, seq, chunk, geometryEpoch)
sendSnapshotNow(sid, seq, snapshot, geometry)
sendResizeBarrier(sid, seq, snapshot, geometry)
```

- [ ] **Step 1: Update the simulated desktop and make the harness fail on old behavior**

```js
const receivedMessages = [];

function addSession(sid, options = {}) {
  sessions.set(sid, {
    sid,
    cwd: options.cwd ?? 'C:\\work\\mobile-e2e',
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    geometryEpoch: options.geometryEpoch ?? 0,
    buffer: '',
    seq: 0,
    snapshotProvider: options.snapshotProvider ?? defaultSnapshotProvider,
  });
}

function sendResizeBarrier(sid, seq, snapshot, geometry) {
  const session = sessions.get(sid);
  if (!session) throw new Error(`unknown session: ${sid}`);
  session.cols = geometry.cols;
  session.rows = geometry.rows;
  session.geometryEpoch = geometry.epoch;
  session.seq = seq;
  if (peer.subscribedSid === sid) {
    peer.send({ type: 'session.snapshot', sid, seq, snapshot, geometry });
  }
}

```

Delete `resizes` collection and the `session.resize` handler. Make every
snapshot and chunk require geometry. Change harness startup to fixed
desktop-provided `120 x 30`, expose `receivedMessages` as a read-only getter on
the returned harness object, and insert `receivedMessages.push(message)`
immediately after the existing `const message = JSON.parse(raw)` in
`handleMessage`. Then assert the phone sends no resize request.

- [ ] **Step 2: Run the targeted harness and verify RED**

Run:

```bash
npm run build
node scripts/harness-e2e-mobile-terminal-sync.mjs
```

Expected: FAIL until the production phone understands protocol v2 geometry
barriers and no longer emits `session.resize`.

- [ ] **Step 3: Extend exact-parity fault scenarios**

Add reference-terminal `resize(cols, rows)` and these deterministic cases:

```js
const cases = [
  ['duplicate-and-stale', caseDuplicateAndStale],
  ['snapshot-live-overlap', caseSnapshotLiveOverlap],
  ['gap-recovery', caseGapRecovery],
  ['future-epoch-before-barrier', caseFutureEpochBeforeBarrier],
  ['active-output-during-resize', caseActiveOutputDuringResize],
  ['stale-and-superseded-barriers', caseStaleAndSupersededBarriers],
  ['buffer-overflow-recovery', caseBufferOverflowRecovery],
  ['disconnect-during-burst', caseDisconnectDuringBurst],
  ['session-switch-race', caseSessionSwitchRace],
];
```

For active resize: write old-epoch fixture prefix to the authoritative
headless terminal; resize reference from `120 x 30` to `156 x 36`; write
progress/cursor redraw bytes while withholding the barrier; send two
epoch-1 chunks; publish one epoch-1 snapshot barrier at the captured sequence;
send remaining contiguous epoch-1 tail. Assert one installed geometry epoch,
one reset counter exposed by the test bridge, `lastSeq === FINAL_SEQ`, and exact
`SerializeAddon.serialize()` equality. Include long lines, wraps, cursor
movement, progress redraw, clear screen, and alternate-screen transitions from
the existing fixture.

- [ ] **Step 4: Convert the visual harness to independent viewport assertions**

Replace all `desktop.resizes` waits/assertions with:

```js
assert.equal(
  desktop.receivedMessages.some((message) => message.type === 'session.resize'),
  false,
  'phone viewport changes must send no PTY resize',
);
```

At portrait `390 x 844`, keyboard override `390 x 520`, restored portrait,
landscape `844 x 390`, and browser zoom, assert canonical geometry remains
`120 x 30`. Send a desktop barrier to `160 x 36`; assert `.mobile-terminal__grid`
is wider than portrait viewport, native horizontal `scrollLeft` reaches the
right edge, the affordance changes, the rail persists at roughly 24 px, thumb
height is at least 44 px, track click changes logical `viewportY`, pointer drag
uses capture, and helper textarea/composer focus remains unchanged. Keep
composer/keybar within the visual viewport.

- [ ] **Step 5: Run focused harnesses and verify GREEN**

Run:

```bash
npm run build
node scripts/harness-e2e-mobile-remote-relay.mjs
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs
```

Expected: all harnesses print PASS; exact parity holds across every epoch fault,
desktop dimensions never derive from phone, and visual pan/scroll/focus
contracts pass.

Run the same three commands once more with the already configured public relay
environment; do not place its URL in source or logs:

```powershell
if (-not $env:CCSM_RELAY_URL) { throw 'CCSM_RELAY_URL must already be configured' }
node scripts/harness-e2e-mobile-remote-relay.mjs
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs
```

Expected: the public-relay run prints the same PASS results as local Wrangler.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-helpers/mobileRemoteHarness.mjs scripts/harness-e2e-mobile-terminal-sync.mjs scripts/harness-e2e-mobile-remote-relay.mjs scripts/harness-e2e-mobile-remote-visual.mjs scripts/fixtures/mobile-remote-pty-fixture.mjs scripts/run-all-e2e.mjs
git commit -m "test(mobile): cover terminal geometry barriers"
```

### Task 10: Acceptance Documentation and Final Gates

**Files:**
- Create: `docs/reference/mobile-terminal-independent-viewport-acceptance.md`
- Modify: `docs/README.md`
- Verify only: all production/test files changed in Tasks 1-9

**Interfaces:**
- Consumes: All prior task contracts and the separately fixed phone Send branch only during the final combined physical test.
- Produces: A durable automated/physical acceptance checklist with no release action.

- [ ] **Step 1: Write the acceptance document**

```markdown
# Mobile terminal independent viewport acceptance

## Automated evidence

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `node scripts/harness-e2e-mobile-remote-relay.mjs`
- `node scripts/harness-e2e-mobile-terminal-sync.mjs`
- `node scripts/harness-e2e-mobile-remote-visual.mjs`
- `npm run probe:e2e`

Record the date, commit SHA, platform, and pass/fail output for each command.
Do not include pairing secrets, encrypted frames, PTY plaintext, drafts, or
user snapshot contents.

## Physical phone checklist

Use the public relay and a real Claude session. Verify:

1. Desktop window drag commits one redraw after the 140 ms debounce.
2. Phone connect, rotation, keyboard open/close, browser zoom, and pan do not
   change desktop PTY columns or rows.
3. Long lines remain normal-size text and pan horizontally in portrait and
   landscape.
4. The right rail stays visible; thumb drag and track jump move terminal
   history; no scrollbar action opens the keyboard.
5. At-bottom output follows; scrolled-up history keeps nearest
   distance-from-bottom through output, barrier, reconnect, and session switch.
6. Terminal text selection and copy work without focusing the xterm helper.
7. Final serialized phone terminal matches the authoritative session after
   active output, resize, reconnect, and session switching.
8. Composer position and focus remain stable through every terminal transition.
9. The separately fixed Send path submits without requiring an extra Enter.
10. Connecting or resizing the phone never shrinks the desktop terminal.

Items 9 and 10 must pass in the same final physical run. This feature does not
change the Send implementation.
```

Add this page to the existing reference index in `docs/README.md`.

- [ ] **Step 2: Run focused unit/integration tests**

Run:

```bash
npx vitest run tests/mobile/mobileRemoteProtocol.test.ts tests/mobile/relayClient.test.ts tests/mobile/terminalSync.test.ts tests/mobile/mobileRemoteStore.test.ts tests/mobile/mobileTerminalAdapter.test.ts tests/mobile/terminalScrollMetrics.test.ts tests/mobile/MobileTerminalScrollbar.test.tsx tests/mobile/MobileTerminal.test.tsx tests/mobile/PhoneShell.test.tsx tests/mobile/mobileCss.test.ts tests/terminal/visibleDesktopResize.test.ts tests/terminal/shellRegistry.test.ts electron/ptyHost/__tests__/lifecycle.test.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts electron/ptyHost/__tests__/terminalSyncCoordinator.test.ts electron/ptyHost/__tests__/bufferSnapshot.test.ts electron/ptyHost/__tests__/dataFanout.test.ts electron/remote/__tests__/ptyFanout.test.ts electron/remote/__tests__/remoteMessages.test.ts
```

Expected: PASS with no skipped geometry, scrollbar, or focus test.

- [ ] **Step 3: Run repository gates**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: every command exits `0`; version remains `0.2.20`.

- [ ] **Step 4: Run deterministic E2E gates**

Run:

```bash
node scripts/harness-e2e-mobile-remote-relay.mjs
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs
npm run probe:e2e
```

Expected: each focused harness and the full discovered E2E suite prints PASS
with no exact-parity, viewport, or process-cleanup failure.

- [ ] **Step 5: Run the combined physical acceptance**

The separately reviewed Send fix is exactly
`61af85f11fcecc45b6c2a3aa68b825acefb9b59f`. The viewport implementation does
not modify Send code or recreate any part of that fix. First verify the donor
descends from the shared PR #1481 base and inspect all implementation/review
evidence:

```powershell
$send = '61af85f11fcecc45b6c2a3aa68b825acefb9b59f'
git merge-base --is-ancestor 96cf4114 $send
if ($LASTEXITCODE -ne 0) { throw 'Send donor does not descend from 96cf4114' }
git show --stat --oneline --decorate --no-renames $send
git show --format=fuller --no-ext-diff $send -- electron/ptyHost/lifecycle.ts electron/ptyHost/index.ts electron/ptyHost/__tests__/lifecycle.test.ts electron/remote/remoteMessages.ts electron/remote/__tests__/remoteMessages.test.ts scripts/harness-e2e-mobile-remote-relay.mjs tests/mobile/mobileRemoteStore.test.ts
git diff --check "$send^" $send
```

Expected: the ancestry command exits `0`; the diff contains exactly these
seven files:

```text
electron/ptyHost/__tests__/lifecycle.test.ts
electron/ptyHost/index.ts
electron/ptyHost/lifecycle.ts
electron/remote/__tests__/remoteMessages.test.ts
electron/remote/remoteMessages.ts
scripts/harness-e2e-mobile-remote-relay.mjs
tests/mobile/mobileRemoteStore.test.ts
```

Review evidence must show the headless FIFO barrier before reading
`bracketedPasteMode`, entry-identity recheck after the barrier, one combined
payload-plus-Enter PTY write, awaited remote acknowledgement, explicit barrier
failure mapping, no masking `session.input`, and relay-harness regression
coverage. It must contain no terminal geometry, viewport, FitAddon, scrollbar,
or resize-authority implementation.

Integrate the donor once. Skip integration only when commit ancestry or stable
patch-id equivalence proves it is already present:

```powershell
$send = '61af85f11fcecc45b6c2a3aa68b825acefb9b59f'
git merge-base --is-ancestor $send HEAD
if ($LASTEXITCODE -eq 0) {
  Write-Output 'Send donor already present by ancestry; skip cherry-pick'
} else {
  $patchState = (git cherry HEAD $send "$send^" | Out-String).Trim()
  if ($patchState -match '^- ') {
    Write-Output 'Send donor already present by stable patch-id; skip cherry-pick'
  } elseif ($patchState -match '^\\+ ') {
    git cherry-pick --no-commit $send
    if ($LASTEXITCODE -ne 0) {
      git diff --name-only --diff-filter=U
      throw 'Stop before commit and resolve only the listed Send/viewport overlaps using the rules below'
    }
  } else {
    throw "Unable to prove Send donor presence or absence: $patchState"
  }
}
```

Expected: an ancestor/equivalent patch prints one explicit skip reason, or the
`+ 61af85f...` result stages the donor or stops with the exact unmerged paths.
For conflicts, resolve line-by-line:

- in `lifecycle.ts` and `index.ts`, retain Task 2/3 canonical geometry and
  ordered barrier code while applying the donor's async FIFO-barrier `submit`
  signature and call;
- in `remoteMessages.ts`, retain the Task 2 legacy resize no-PTY behavior and
  await the donor submit before sending its result;
- in lifecycle/remote tests, retain both geometry authority cases and donor
  FIFO, replacement-entry, failure, acknowledgement-order, and no-extra-input
  cases;
- in the relay harness/store test, retain canonical geometry fixtures while
  applying only the donor Send acknowledgement/input assertions.

Do not use a broad ours/theirs checkout. For the `+` path only, stage the seven
reviewed paths, verify there are no unresolved or unexpected files, and
preserve the donor commit message:

```powershell
$send = '61af85f11fcecc45b6c2a3aa68b825acefb9b59f'
$expected = @(
  'electron/ptyHost/__tests__/lifecycle.test.ts',
  'electron/ptyHost/index.ts',
  'electron/ptyHost/lifecycle.ts',
  'electron/remote/__tests__/remoteMessages.test.ts',
  'electron/remote/remoteMessages.ts',
  'scripts/harness-e2e-mobile-remote-relay.mjs',
  'tests/mobile/mobileRemoteStore.test.ts'
)
git add -- $expected
$unmerged = @(git diff --name-only --diff-filter=U)
if ($unmerged.Count -ne 0) { throw "Unresolved Send conflicts: $($unmerged -join ', ')" }
$staged = @(git diff --cached --name-only)
$unexpected = @($staged | Where-Object { $_ -notin $expected })
if ($unexpected.Count -ne 0) { throw "Unexpected staged paths: $($unexpected -join ', ')" }
git diff --cached --check
git diff --cached --stat
git commit -C $send
```

Expected: one reviewed Send commit with only the seven-file list above. The
combined diff preserves both independent behaviors without copying phone
viewport dimensions into PTY state.

Verify the integrated candidate before physical testing:

```bash
npx vitest run electron/ptyHost/__tests__/lifecycle.test.ts electron/remote/__tests__/remoteMessages.test.ts tests/mobile/mobileRemoteStore.test.ts
npm run typecheck
npm run build
node scripts/harness-e2e-mobile-remote-relay.mjs
```

Expected: every command exits `0`, Send acknowledgement follows the FIFO
barrier and PTY write, no follow-up `session.input` appears, and viewport
geometry tests remain unchanged.

Execute all ten physical checklist items in one public-relay phone session.
Record only non-sensitive results in the acceptance document. If either Send
requires an extra Enter or the phone shrinks the desktop, mark the candidate
failed and do not deploy, tag, or release.

- [ ] **Step 6: Commit documentation only after evidence is complete**

```bash
git add docs/reference/mobile-terminal-independent-viewport-acceptance.md docs/README.md
git commit -m "docs(mobile): record viewport acceptance"
```

The implementation branch is ready for review after this commit. Deployment,
tagging, release, and PR merge remain separate user-approved operations.
