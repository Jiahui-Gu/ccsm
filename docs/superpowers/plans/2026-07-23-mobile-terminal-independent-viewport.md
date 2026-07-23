# Mobile Terminal Independent Viewport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one desktop-sized Claude PTY authoritative while a phone renders the same ordered terminal grid through an independently clipped, pannable, scrollable viewport.

**Architecture:** The main process owns one canonical `{ cols, rows, epoch }` per PTY and serializes every committed desktop resize through one snapshot-barrier coordinator. Desktop and phone consume the same epoch-tagged raw byte stream; the phone extends its existing strict 256-chunk synchronization reducer, resizes xterm only to canonical geometry, and treats browser viewport changes as clipping and pan state. A persistent custom vertical scrollbar projects xterm's logical buffer metrics without using DOM `scrollTop`.

**Tech Stack:** Electron 41, React 18, TypeScript 5.7, zustand vanilla, xterm.js 5.5, node-pty, Vitest, Testing Library, Playwright, Cloudflare Wrangler, npm on Node.js 22 or newer.

## Global Constraints

- Use npm only. Do not run pnpm or yarn.
- Require Node.js `>=22.0.0`; do not change `.npmrc` or `engines.node`.
- Keep `package.json` and lockfile version at `0.2.20`.
- Keep one canonical node-pty process and one authoritative headless xterm per session.
- The currently visible desktop terminal is the sole canonical resize authority.
- Debounce continuous desktop geometry changes for 140 ms, within the approved 120-150 ms range.
- Hidden desktop shells, unmounted shells, phones, and relays never commit canonical geometry.
- Treat every committed canonical resize as an ordered geometry-epoch snapshot barrier.
- Preserve the existing `MAX_BUFFERED_TERMINAL_CHUNKS = 256` phone recovery bound.
- Phone fit, `visualViewport`, browser zoom, orientation, keyboard, and container changes never send `session.resize`.
- Preserve raw PTY byte order, encryption, frame bounds, and relay opacity; the relay does not interpret ANSI.
- Keep phone xterm read-only. Do not register `terminal.onData`; do not call terminal/helper-textarea `focus()` or `blur()`; the composer remains the sole keyboard entry surface.
- Renderer code under `src/` accesses main only through typed `window.ccsmPty`; it never imports from `electron/`.
- Keep the last valid phone frame visible through malformed data, reconnect, gaps, and replacement snapshot waits.
- Do not redesign or reimplement Send behavior in viewport tasks. Integrate the exact separate fix only in Task 10.
- Use only the ownership tests/evidence and resize-emission removals from `b730487c`; do not cherry-pick that commit because its phone-fit adapter/harness model conflicts with canonical-grid parity. Integrate separate Send fix commit `61af85f1` only in Task 10.
- Do not deploy, merge, tag, or release while implementing these tasks.
- Do not update user-owned snapshots or unrelated visual baselines.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| Browser-safe geometry | `src/shared/mobileRemote/terminalGeometry.ts`, `protocol.ts`, `index.ts` | Canonical geometry, epoch/sequence guards, server message shapes, runtime validation |
| Main canonical state | `electron/ptyHost/entryFactory.ts`, `lifecycle.ts`, `index.ts` | Per-session canonical geometry and desktop-only commit API |
| Ordered coordinator | `electron/ptyHost/terminalStreamCoordinator.ts`, `dataFanout.ts`, `entryFactory.ts`, `lifecycle.ts` | Serialize live chunks, resize barriers, snapshots, and queued tails |
| Main transports | `electron/ptyHost/ipcRegistrar.ts`, `electron/preload/bridges/ccsmPty.ts`, `src/pty.d.ts`, `electron/remote/ptyFanout.ts`, `electron/remote/remoteMessages.ts` | Forward one ordered typed terminal stream to desktop and subscribed phone peers |
| Desktop authority | `src/terminal/desktopGeometryOwner.ts`, `usePtyAttachShell.ts`, `shellRegistry.ts` | Visible-only measurement, 140 ms debounce, canonical commit |
| Phone sync | `src/mobile/terminalSync.ts`, `mobileRemoteStore.ts`, `relayClient.ts` | Epoch-aware bounded recovery and render effects |
| Phone adapter | `src/mobile/mobileTerminalAdapter.ts` | Canonical xterm grid, physical viewport metrics/pan, anchors, logical scroll actions |
| Phone scrollbar | `src/mobile/terminalScrollbar.ts`, `components/MobileTerminalScrollbar.tsx` | Pure thumb math and accessible interaction |
| Phone composition | `src/mobile/components/MobileTerminal.tsx`, `PhoneShell.tsx`, `mobile.css`, `testBridge.d.ts` | Integrate stream effects, pan, scrollbar, anchors, safe areas, and test seam |
| Deterministic acceptance | `scripts/fixtures/mobile-remote-pty-fixture.mjs`, `scripts/probe-helpers/mobileRemoteHarness.mjs`, `scripts/harness-e2e-mobile-terminal-sync.mjs`, `scripts/harness-e2e-mobile-remote-visual.mjs` | Local/public encrypted parity, resize overlap, pan, scrollbar, and layout gates |

---

### Task 1: Browser-Safe Geometry Protocol, Types, Version, and Validation

**Files:**
- Create: `src/shared/mobileRemote/terminalGeometry.ts`
- Modify: `src/shared/mobileRemote/protocol.ts:6-84`
- Modify: `src/shared/mobileRemote/index.ts:1-2`
- Modify: `src/mobile/relayClient.ts:86-119, 330-390`
- Create: `tests/shared/mobileRemoteTerminalGeometry.test.ts`
- Modify: `tests/mobile/relayClient.test.ts:132-154, 249-360`

**Interfaces:**
- Consumes: no new application interfaces.
- Produces:
  - `CanonicalTerminalGeometry = { cols: number; rows: number; epoch: number }`
  - `TerminalChunkMessage = { type: 'pty.data'; sid: string; seq: number; geometryEpoch: number; chunk: string }`
  - `SessionSnapshotMessage = { type: 'session.snapshot'; sid: string; seq: number; geometry: CanonicalTerminalGeometry; snapshot: string }`
  - `parseCanonicalTerminalGeometry(value: unknown): CanonicalTerminalGeometry | null`
  - `parseMobileServerMessage(value: unknown): MobileServerMessage | null`
  - `isTerminalSequence(value: unknown): value is number`

- [ ] **Step 1: Write failing browser-safe validation tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  parseCanonicalTerminalGeometry,
  parseMobileServerMessage,
} from '../../../src/shared/mobileRemote';

describe('canonical terminal geometry protocol', () => {
  it('accepts bounded integral geometry and epoch zero', () => {
    expect(parseCanonicalTerminalGeometry({ cols: 120, rows: 30, epoch: 0 })).toEqual({
      cols: 120,
      rows: 30,
      epoch: 0,
    });
  });

  it.each([
    { cols: 1, rows: 30, epoch: 0 },
    { cols: 120, rows: 1, epoch: 0 },
    { cols: 1001, rows: 30, epoch: 0 },
    { cols: 120, rows: 1001, epoch: 0 },
    { cols: 80.5, rows: 24, epoch: 0 },
    { cols: 80, rows: 24, epoch: -1 },
    { cols: 80, rows: 24, epoch: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects unsafe geometry %#', (value) => {
    expect(parseCanonicalTerminalGeometry(value)).toBeNull();
  });

  it('validates an authoritative snapshot barrier and its sequence', () => {
    expect(
      parseMobileServerMessage({
        type: 'session.snapshot',
        sid: 's1',
        seq: 42,
        geometry: { cols: 120, rows: 30, epoch: 3 },
        snapshot: 'screen',
      }),
    ).toEqual({
      type: 'session.snapshot',
      sid: 's1',
      seq: 42,
      geometry: { cols: 120, rows: 30, epoch: 3 },
      snapshot: 'screen',
    });
  });

  it('rejects live data without a safe geometry epoch', () => {
    expect(
      parseMobileServerMessage({ type: 'pty.data', sid: 's1', seq: 43, chunk: 'x' }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the geometry tests and verify RED**

Run:

```bash
npm test -- tests/shared/mobileRemoteTerminalGeometry.test.ts
```

Expected: FAIL because `terminalGeometry.ts`, `parseCanonicalTerminalGeometry`, and `parseMobileServerMessage` do not exist.

- [ ] **Step 3: Add the complete browser-safe geometry contract**

```ts
// src/shared/mobileRemote/terminalGeometry.ts
export const MIN_CANONICAL_TERMINAL_DIMENSION = 2;
export const MAX_CANONICAL_TERMINAL_DIMENSION = 1000;

export type CanonicalTerminalGeometry = {
  cols: number;
  rows: number;
  epoch: number;
};

export function isTerminalSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseCanonicalTerminalGeometry(
  value: unknown,
): CanonicalTerminalGeometry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.cols) ||
    !Number.isInteger(record.rows) ||
    !isTerminalSequence(record.epoch)
  ) {
    return null;
  }
  const cols = record.cols as number;
  const rows = record.rows as number;
  if (
    cols < MIN_CANONICAL_TERMINAL_DIMENSION ||
    rows < MIN_CANONICAL_TERMINAL_DIMENSION ||
    cols > MAX_CANONICAL_TERMINAL_DIMENSION ||
    rows > MAX_CANONICAL_TERMINAL_DIMENSION
  ) {
    return null;
  }
  return { cols, rows, epoch: record.epoch as number };
}
```

Update `protocol.ts` so these are the only terminal stream wire shapes:

```ts
import {
  isTerminalSequence,
  parseCanonicalTerminalGeometry,
  type CanonicalTerminalGeometry,
} from './terminalGeometry';

export type SessionListEntry = {
  sid: string;
  cwd: string;
  geometry: CanonicalTerminalGeometry;
};

export type TerminalChunkMessage = {
  type: 'pty.data';
  sid: string;
  seq: number;
  geometryEpoch: number;
  chunk: string;
};

export type SessionSnapshotMessage = {
  type: 'session.snapshot';
  sid: string;
  seq: number;
  geometry: CanonicalTerminalGeometry;
  snapshot: string;
};

export type MobileServerMessage =
  | { type: 'sessions.list'; sessions: SessionListEntry[] }
  | {
      type: 'sessions.navigator';
      version: typeof SESSION_NAVIGATOR_MESSAGE_VERSION;
      model: SessionNavigatorModel;
    }
  | SessionSnapshotMessage
  | TerminalChunkMessage
  | SessionSubmitResult
  | { type: 'error'; message: string };

export function parseMobileServerMessage(value: unknown): MobileServerMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type === 'pty.data') {
    if (
      typeof message.sid !== 'string' ||
      typeof message.chunk !== 'string' ||
      !isTerminalSequence(message.seq) ||
      !isTerminalSequence(message.geometryEpoch)
    ) {
      return null;
    }
    return message as TerminalChunkMessage;
  }
  if (message.type === 'session.snapshot') {
    const geometry = parseCanonicalTerminalGeometry(message.geometry);
    if (
      typeof message.sid !== 'string' ||
      typeof message.snapshot !== 'string' ||
      !isTerminalSequence(message.seq) ||
      geometry === null
    ) {
      return null;
    }
    return { type: 'session.snapshot', sid: message.sid, seq: message.seq, geometry, snapshot: message.snapshot };
  }
  return message as MobileServerMessage;
}
```

Export `terminalGeometry.ts` from `index.ts`. Keep `MOBILE_REMOTE_PROTOCOL_VERSION = 1`; the approved design extends authenticated application payloads without changing handshake compatibility or app version `0.2.20`.

- [ ] **Step 4: Validate decrypted application messages before dispatch**

After `openEnvelope` and `JSON.parse` in `relayClient.ts`, call `parseMobileServerMessage`. If parsing returns `null`, emit `connection_error`, close the current socket with code `1007` and reason `invalid_application_message`, and do not invoke message handlers. Keep envelope sequence and crypto logic unchanged.

Representative test:

```ts
it('closes authenticated transport on malformed terminal geometry', async () => {
  const received: unknown[] = [];
  client.onMessage((message) => received.push(message));
  await authenticate(client, socket, 'D'.repeat(22));
  socket.receive(await encryptedFromDesktop({
    type: 'session.snapshot',
    sid: 's1',
    seq: 4,
    geometry: { cols: 0, rows: 24, epoch: 1 },
    snapshot: 'bad',
  }));
  await vi.waitFor(() => expect(socket.readyState).toBe(3));
  expect(received).toEqual([]);
});
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/shared/mobileRemoteTerminalGeometry.test.ts tests/mobile/relayClient.test.ts
```

Expected: both files PASS; malformed terminal messages never reach handlers.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/shared/mobileRemote/terminalGeometry.ts src/shared/mobileRemote/protocol.ts src/shared/mobileRemote/index.ts src/mobile/relayClient.ts tests/shared/mobileRemoteTerminalGeometry.test.ts tests/mobile/relayClient.test.ts
git commit -m "feat(remote): define canonical terminal geometry protocol" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Canonical Geometry State and Desktop-Only Ownership

**Selective donor rule (blocking):** `b730487c` is read-only evidence. Never run `git cherry-pick b730487c`, never apply the commit as a whole, and never treat a phone FitAddon measurement as canonical geometry.

**Files:**
- Inspect selectively, never cherry-pick: commit `b730487c` (`fix: keep mobile terminal resize local`)
- Reuse ownership evidence: `electron/remote/__tests__/remoteMessages.test.ts` (`session.resize ownership`)
- Create legacy emission test: `electron/remote/__tests__/mobilePage.test.ts`
- Modify emission paths: `electron/remote/remoteMessages.ts:1-8, 138-152`, `electron/remote/mobilePage.ts:100-145, 186-202`, `src/mobile/components/PhoneShell.tsx:138-168`
- Modify ownership tests: `tests/mobile/PhoneShell.test.tsx:713-753`
- Modify compatibility comment only: `src/shared/mobileRemote/protocol.ts:49-54`
- Modify canonical state: `electron/ptyHost/entryFactory.ts:64-99, 302-336`
- Modify: `electron/ptyHost/lifecycle.ts:21-49, 51-125, 186-205`
- Modify: `electron/ptyHost/index.ts:54-104`
- Modify: `electron/ptyHost/__tests__/entryFactory.test.ts`
- Modify: `electron/ptyHost/__tests__/lifecycle.test.ts`
- Explicitly reject from `b730487c`: `scripts/fixtures/mobile-remote-pty-fixture.mjs`, `scripts/harness-e2e-mobile-remote-visual.mjs`, `scripts/harness-e2e-mobile-terminal-sync.mjs`, `scripts/probe-helpers/mobileRemoteHarness.mjs`, `src/mobile/testBridge.d.ts`, `tests/mobile/bootstrap.test.tsx`, `tests/mobile/testBridge.test.tsx`, and the `PhoneShell.tsx` `dimensionsRef/getDimensions/fit(true)` hunks.

**Interfaces:**
- Consumes: `CanonicalTerminalGeometry`, `parseCanonicalTerminalGeometry` from Task 1.
- Produces:
  - `Entry.geometry: CanonicalTerminalGeometry` as the only in-memory canonical dimension state.
  - `PtySessionInfo.geometry: CanonicalTerminalGeometry`
  - `AttachResult.geometry: CanonicalTerminalGeometry`
  - `commitCanonicalGeometry(sessions, sid, cols, rows): Promise<CanonicalTerminalGeometry | null>` temporarily performs the current resize and returns the installed/current geometry; Task 3 replaces its internals with the coordinator without changing the signature.

- [ ] **Step 1: Inspect and classify the root-cause commit without applying it**

Run:

```bash
git merge-base --is-ancestor 96cf4114 b730487c
git diff --check 96cf4114 b730487c
git show --stat --oneline b730487c
git show --format= b730487c -- electron/remote/remoteMessages.ts electron/remote/__tests__/remoteMessages.test.ts
git diff b730487c^ b730487c -- electron/remote/mobilePage.ts src/mobile/components/PhoneShell.tsx tests/mobile/PhoneShell.test.tsx
git diff b730487c^ b730487c -- scripts/harness-e2e-mobile-terminal-sync.mjs scripts/harness-e2e-mobile-remote-visual.mjs scripts/probe-helpers/mobileRemoteHarness.mjs src/mobile/testBridge.d.ts
```

Expected: ancestry/whitespace checks exit 0 and the stat lists 13 files. The focused donor views establish four selectively reusable items:

1. ownership RED tests proving phone `session.resize` reaches no PTY resize;
2. remote legacy `session.resize` validation plus valid-message no-op behavior;
3. outgoing `session.resize` removal from current React phone and legacy `mobilePage`;
4. reproduction methodology: record real Electron PTY geometry before phone connection, connect a narrow phone, exercise rotation/keyboard/viewport changes, then compare the same live PTY geometry afterward.

The final focused diff is rejection evidence. Do not port any hunk that resizes phone xterm to physical FitAddon dimensions, reports phone-fit `getDimensions()` as canonical, calls `setSessionDimensions(phoneDims)` in a parity harness, or changes the reference terminal to phone dimensions. Those changes weaken cross-viewport canonical parity and are superseded by Tasks 3, 6, and 9.

- [ ] **Step 2: Write failing desktop-authority and emission-removal tests from the reusable evidence**

Reuse the root-cause assertion from `b730487c`:

```ts
it('keeps desktop PTY/headless dimensions authoritative when a legacy phone reports its viewport size', async () => {
  const peer = makePeer();
  await handleClientMessage(
    peer,
    JSON.stringify({ type: 'session.resize', sid: 's1', cols: 42, rows: 28 }),
  );
  expect(mockedPty.resizePtySession).not.toHaveBeenCalled();
  expect(peer.send).not.toHaveBeenCalled();
});

it('still rejects malformed legacy resize messages', async () => {
  const peer = makePeer();
  await handleClientMessage(
    peer,
    JSON.stringify({ type: 'session.resize', sid: 's1', cols: 0.5, rows: 28 }),
  );
  expect(mockedPty.resizePtySession).not.toHaveBeenCalled();
  expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'invalid_resize' });
});
```

Add a `PhoneShell` test that invokes the transitional adapter measurement callback and proves `client.sent` contains no `session.resize`. Add a legacy-page source contract:

```ts
it('does not emit session.resize from the legacy phone page', () => {
  const html = renderMobilePage();
  expect(html).not.toContain("send({ type: 'session.resize'");
});
```

- [ ] **Step 3: Run ownership tests and verify RED**

Run:

```bash
npm test -- electron/remote/__tests__/remoteMessages.test.ts electron/remote/__tests__/mobilePage.test.ts tests/mobile/PhoneShell.test.tsx
```

Expected: FAIL because remote `session.resize` still reaches `resizePtySession`, current `PhoneShell` still sends it, and the legacy inline page still emits it.

- [ ] **Step 4: Apply only the ownership fix and emission removals**

In `remoteMessages.ts`, remove the `resizePtySession` import. Keep legacy validation, then return without mutation:

```ts
if (message.type === 'session.resize') {
  if (
    typeof message.sid !== 'string' ||
    !Number.isInteger(message.cols) ||
    !Number.isInteger(message.rows)
  ) {
    client.send({ type: 'error', message: 'invalid_resize' });
    return;
  }
  return;
}
```

In `PhoneShell.tsx`, replace the send callback with a temporary physical-measurement compatibility callback that has no wire side effect:

```ts
const handleViewportMeasurement = useCallback(
  (_dimensions: { cols: number; rows: number }) => undefined,
  [],
);
```

Pass it to the current `MobileTerminal` only until Task 6 removes FitAddon and Task 8 removes the callback surface. Do not add `dimensionsRef`, `getDimensions()`, or a forced `fit(true)` session-switch effect.

In `mobilePage.ts`, remove `lastSentCols`, `lastSentRows`, and the `send({ type: 'session.resize', ... })` block. Leave legacy local drawing behavior unchanged in this task; canonical epoch/barrier and canonical phone-grid work land in Tasks 3-6.

Add only a compatibility comment to the shared `session.resize` union: it exists for already-deployed clients and is validated/ignored by desktop.

Apply these edits manually as the explicit selective patch; do not invoke Git's cherry-pick machinery:

```diff
diff --git a/src/mobile/components/PhoneShell.tsx b/src/mobile/components/PhoneShell.tsx
@@
-  const handleResize = useCallback(
-    (dimensions: { cols: number; rows: number }) => {
-      const current = store.getState();
-      if (!current.selectedSessionId || !current.inputEnabled) return;
-      void client.send({
-        type: 'session.resize',
-        sid: current.selectedSessionId,
-        cols: dimensions.cols,
-        rows: dimensions.rows,
-      }).catch(() => undefined);
-    },
-    [client, store],
-  );
+  const handleViewportMeasurement = useCallback(
+    (_dimensions: { cols: number; rows: number }) => undefined,
+    [],
+  );
@@
-        onResize={handleResize}
+        onResize={handleViewportMeasurement}

diff --git a/electron/remote/mobilePage.ts b/electron/remote/mobilePage.ts
@@
-    let lastSentCols = 0;
-    let lastSentRows = 0;
@@
-      if (!activeSid) return;
-      if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
-      lastSentCols = dims.cols;
-      lastSentRows = dims.rows;
-      send({ type: 'session.resize', sid: activeSid, cols: dims.cols, rows: dims.rows });
@@
-      lastSentCols = 0;
-      lastSentRows = 0;
```

After this selective patch, no Task 2 state, test bridge, or harness may contain `phoneDims` or `setSessionDimensions(phoneDims)`.

- [ ] **Step 5: Run selective ownership tests and verify GREEN**

Run:

```bash
npm test -- electron/remote/__tests__/remoteMessages.test.ts electron/remote/__tests__/mobilePage.test.ts tests/mobile/PhoneShell.test.tsx
```

Expected: PASS; current and legacy phone paths emit no resize, valid legacy resize input is ignored, and malformed legacy input remains observable as `invalid_resize`.

- [ ] **Step 6: Commit the selective root-cause ownership fix**

```bash
git add electron/remote/remoteMessages.ts electron/remote/__tests__/remoteMessages.test.ts electron/remote/mobilePage.ts electron/remote/__tests__/mobilePage.test.ts src/mobile/components/PhoneShell.tsx tests/mobile/PhoneShell.test.tsx src/shared/mobileRemote/protocol.ts
git commit -m "fix(remote): reserve PTY resize for desktop" -m "Reuses ownership evidence from b730487c; intentionally excludes its phone-fit adapter and harness hunks." -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 7: Write failing canonical-state tests**

```ts
it('stores one canonical geometry object and preserves it while detached', () => {
  const sessions = new Map<string, Entry>();
  spawn(sessions, 's1', cwd, claudePath, { cols: 120, rows: 30 });
  expect(get(sessions, 's1')?.geometry).toEqual({ cols: 120, rows: 30, epoch: 0 });

  detach(sessions, 's1');
  expect(attach(sessions, 's1')?.geometry).toEqual({ cols: 120, rows: 30, epoch: 0 });
});

it('rejects invalid and no-op canonical geometry without mutating either terminal', async () => {
  const entry = makeFakeEntry({ cols: 120, rows: 30, epoch: 2 });
  const sessions = new Map([['s1', entry]]);
  await expect(commitCanonicalGeometry(sessions, 's1', 120, 30)).resolves.toEqual({
    cols: 120,
    rows: 30,
    epoch: 2,
  });
  await expect(commitCanonicalGeometry(sessions, 's1', 1, 30)).resolves.toBeNull();
  expect(entry.pty.resize).not.toHaveBeenCalled();
  expect(entry.headless.resize).not.toHaveBeenCalled();
});
```

- [ ] **Step 8: Run the lifecycle test and verify RED**

Run:

```bash
npm test -- electron/ptyHost/__tests__/lifecycle.test.ts electron/ptyHost/__tests__/entryFactory.test.ts
```

Expected: FAIL because `Entry.geometry`, geometry-bearing return types, and `commitCanonicalGeometry` are missing.

- [ ] **Step 9: Replace duplicated `cols`/`rows` entry state with canonical geometry**

In `Entry`, remove mutable `cols` and `rows` fields and add:

```ts
geometry: CanonicalTerminalGeometry;
```

Initialize it once:

```ts
geometry: { cols, rows, epoch: 0 },
```

Update `infoFromEntry`, `attach`, `listEntries`, and IPC attach responses to clone `entry.geometry`. Do not expose a mutable object reference:

```ts
function cloneGeometry(geometry: CanonicalTerminalGeometry): CanonicalTerminalGeometry {
  return { cols: geometry.cols, rows: geometry.rows, epoch: geometry.epoch };
}
```

Implement the temporary commit seam:

```ts
export async function commitCanonicalGeometry(
  sessions: Map<string, Entry>,
  sid: string,
  cols: number,
  rows: number,
): Promise<CanonicalTerminalGeometry | null> {
  const entry = sessions.get(sid);
  if (!entry) return null;
  const parsed = parseCanonicalTerminalGeometry({
    cols,
    rows,
    epoch: entry.geometry.epoch + 1,
  });
  if (!parsed) return null;
  if (parsed.cols === entry.geometry.cols && parsed.rows === entry.geometry.rows) {
    return cloneGeometry(entry.geometry);
  }
  entry.pty.resize(parsed.cols, parsed.rows);
  entry.headless.resize(parsed.cols, parsed.rows);
  entry.geometry = parsed;
  return cloneGeometry(parsed);
}
```

Only desktop IPC calls this seam. `remoteMessages.ts` must not import or call it. Keep the selectively implemented legacy resize branch as a validated no-op.

- [ ] **Step 10: Run focused tests and verify GREEN**

Run:

```bash
npm test -- electron/ptyHost/__tests__/lifecycle.test.ts electron/ptyHost/__tests__/entryFactory.test.ts electron/remote/__tests__/remoteMessages.test.ts electron/remote/__tests__/mobilePage.test.ts tests/mobile/PhoneShell.test.tsx
```

Expected: PASS; detach preserves canonical geometry and phone paths never call PTY resize.

- [ ] **Step 11: Commit canonical-state additions**

```bash
git add electron/ptyHost/entryFactory.ts electron/ptyHost/lifecycle.ts electron/ptyHost/index.ts electron/remote/remoteMessages.ts src/shared/mobileRemote/protocol.ts electron/ptyHost/__tests__/entryFactory.test.ts electron/ptyHost/__tests__/lifecycle.test.ts
git commit -m "refactor(pty): centralize canonical terminal geometry" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Ordered Geometry Epoch and Atomic Authoritative Coordinator

**Files:**
- Create: `electron/ptyHost/terminalStreamCoordinator.ts`
- Create: `electron/ptyHost/__tests__/terminalStreamCoordinator.test.ts`
- Modify: `electron/ptyHost/dataFanout.ts:10-38`
- Modify: `electron/ptyHost/entryFactory.ts:64-99, 150-220, 323-337`
- Modify: `electron/ptyHost/lifecycle.ts:186-205, 392-510`
- Modify: `electron/ptyHost/index.ts:54-126`
- Modify: `electron/remote/ptyFanout.ts:1-12`
- Modify: `electron/remote/remoteMessages.ts:66-84`
- Modify: `electron/remote/__tests__/remoteMessages.test.ts`

**Interfaces:**
- Consumes: Task 1 `CanonicalTerminalGeometry`, `TerminalChunkMessage`, `SessionSnapshotMessage`; Task 2 `Entry.geometry`.
- Produces:
  - `TerminalStreamEvent = TerminalChunkMessage | SessionSnapshotMessage`
  - `TerminalStreamCoordinator.publishChunk(seq: number, chunk: string): void`
  - `TerminalStreamCoordinator.commitGeometry(cols: number, rows: number): Promise<CanonicalTerminalGeometry>`
  - `TerminalStreamCoordinator.requestSnapshot(): Promise<SessionSnapshotMessage>`
  - `onTerminalStream(cb: (event: TerminalStreamEvent) => void): () => void`
  - `commitCanonicalGeometry(sessions, sid, cols, rows): Promise<CanonicalTerminalGeometry | null>`
  - `getAuthoritativeSnapshot(sessions, sid): Promise<SessionSnapshotMessage | null>`

- [ ] **Step 1: Write failing coordinator ordering tests**

Use a fake port with a synchronous serializer and a controllable `drainHeadless` promise:

```ts
it('publishes one resize barrier before the new-epoch contiguous tail', async () => {
  const published: TerminalStreamEvent[] = [];
  const drain = deferred<void>();
  let geometry = { cols: 120, rows: 30, epoch: 0 };
  let snapshot = 'old';
  const coordinator = new TerminalStreamCoordinator('s1', {
    getGeometry: () => geometry,
    setGeometry: (next) => { geometry = next; },
    resize: vi.fn(),
    drainHeadless: () => drain.promise,
    serialize: () => snapshot,
    currentSeq: () => 12,
    publish: (event) => published.push(event),
  });

  coordinator.publishChunk(10, 'old-tail');
  const committing = coordinator.commitGeometry(100, 40);
  coordinator.publishChunk(11, 'covered-by-snapshot');
  snapshot = 'new-screen';
  drain.resolve();
  await committing;
  coordinator.publishChunk(13, 'new-tail');

  expect(published).toEqual([
    { type: 'pty.data', sid: 's1', seq: 10, geometryEpoch: 0, chunk: 'old-tail' },
    {
      type: 'session.snapshot',
      sid: 's1',
      seq: 12,
      geometry: { cols: 100, rows: 40, epoch: 1 },
      snapshot: 'new-screen',
    },
    { type: 'pty.data', sid: 's1', seq: 13, geometryEpoch: 1, chunk: 'new-tail' },
  ]);
});

it('queues a later geometry behind the active barrier and skips no-ops', async () => {
  const first = coordinator.commitGeometry(100, 40);
  const second = coordinator.commitGeometry(90, 35);
  await Promise.all([first, second]);
  expect(port.resize.mock.calls).toEqual([[100, 40], [90, 35]]);
  expect(port.publish.filter((event) => event.type === 'session.snapshot')).toHaveLength(2);
  await coordinator.commitGeometry(90, 35);
  expect(port.publish.filter((event) => event.type === 'session.snapshot')).toHaveLength(2);
});

it('waits for an active resize before answering a recovery snapshot', async () => {
  const resize = coordinator.commitGeometry(100, 40);
  const requested = coordinator.requestSnapshot();
  drain.resolve();
  await resize;
  await expect(requested).resolves.toMatchObject({
    geometry: { cols: 100, rows: 40, epoch: 1 },
  });
});
```

- [ ] **Step 2: Run coordinator tests and verify RED**

Run:

```bash
npm test -- electron/ptyHost/__tests__/terminalStreamCoordinator.test.ts
```

Expected: FAIL because the coordinator module is absent.

- [ ] **Step 3: Implement the serialized coordinator**

The complete public contract and queueing core:

```ts
export type TerminalCoordinatorPort = {
  getGeometry(): CanonicalTerminalGeometry;
  setGeometry(next: CanonicalTerminalGeometry): void;
  resize(cols: number, rows: number): void;
  drainHeadless(): Promise<void>;
  serialize(): string;
  currentSeq(): number;
  publish(event: TerminalStreamEvent): void;
};

export class TerminalStreamCoordinator {
  private transition: Promise<void> = Promise.resolve();
  private barrierActive = false;
  private queued: Array<{ seq: number; chunk: string }> = [];

  constructor(
    private readonly sid: string,
    private readonly port: TerminalCoordinatorPort,
  ) {}

  publishChunk(seq: number, chunk: string): void {
    if (this.barrierActive) {
      this.queued.push({ seq, chunk });
      return;
    }
    this.publishLive(seq, chunk);
  }

  commitGeometry(cols: number, rows: number): Promise<CanonicalTerminalGeometry> {
    const run = this.transition.then(() => this.installGeometry(cols, rows));
    this.transition = run.then(() => undefined, () => undefined);
    return run;
  }

  async requestSnapshot(): Promise<SessionSnapshotMessage> {
    await this.transition;
    await this.port.drainHeadless();
    return this.captureSnapshot();
  }

  private async installGeometry(
    cols: number,
    rows: number,
  ): Promise<CanonicalTerminalGeometry> {
    const current = this.port.getGeometry();
    const parsed = parseCanonicalTerminalGeometry({
      cols,
      rows,
      epoch: current.epoch + 1,
    });
    if (!parsed) throw new RangeError('invalid_terminal_geometry');
    if (cols === current.cols && rows === current.rows) return current;

    this.barrierActive = true;
    try {
      this.port.resize(cols, rows);
      this.port.setGeometry(parsed);
      await this.port.drainHeadless();
      const barrier = this.captureSnapshot();
      this.port.publish(barrier);
      for (const pending of this.queued) {
        if (pending.seq > barrier.seq) this.publishLive(pending.seq, pending.chunk);
      }
      this.queued = [];
      return parsed;
    } finally {
      this.barrierActive = false;
    }
  }

  private captureSnapshot(): SessionSnapshotMessage {
    return {
      type: 'session.snapshot',
      sid: this.sid,
      seq: this.port.currentSeq(),
      geometry: { ...this.port.getGeometry() },
      snapshot: this.port.serialize(),
    };
  }

  private publishLive(seq: number, chunk: string): void {
    this.port.publish({
      type: 'pty.data',
      sid: this.sid,
      seq,
      geometryEpoch: this.port.getGeometry().epoch,
      chunk,
    });
  }
}
```

Preserve `getBufferSnapshot`'s current FIFO headless drain and 250 ms ceiling by extracting it as `drainHeadless(entry)`. Do not await between the completed drain and synchronous `seq + serialize` capture.

- [ ] **Step 4: Route all stream publication through the coordinator**

`dispatchPtyChunk` still increments `entry.seq` and writes bytes to headless first. Replace direct attached-webContents and `emitPtyData` publication with:

```ts
entry.coordinator.publishChunk(entry.seq, chunk);
```

The coordinator port's `publish(event)` must:

1. send the event to every live attached desktop `webContents` on the existing ordered terminal channel;
2. call `emitTerminalStream(event)` for remote subscribers;
3. prune destroyed attached entries;
4. preserve current catch-and-warn behavior without dropping or reordering events.

Change `dataFanout.ts` to:

```ts
export type TerminalStreamListener = (event: TerminalStreamEvent) => void;
export function onTerminalStream(cb: TerminalStreamListener): () => void;
export function emitTerminalStream(event: TerminalStreamEvent): void;
```

Retain the existing `PtyDataListener` and `onPtyData(cb)` exports for the notification OSC pipeline. `emitTerminalStream` invokes those legacy listeners only for `pty.data` events, passing `(sid, chunk, seq)`, after it has notified ordered terminal-stream listeners. This keeps the notify subsystem compiling without teaching it snapshot semantics.

Update `ptyFanout.ts` to forward both chunks and authoritative barriers only when `peer.subscribedSid === event.sid`.

- [ ] **Step 5: Make lifecycle resize and snapshot use the same coordinator**

`commitCanonicalGeometry` validates `cols` and `rows`, then awaits `entry.coordinator.commitGeometry`. `getAuthoritativeSnapshot` awaits `entry.coordinator.requestSnapshot`. `remoteMessages.ts` uses `getAuthoritativeSnapshot` after setting `subscribedSid`; it never reads geometry separately from `getPtySession`, eliminating pre-resize-content/post-resize-geometry pairs.

- [ ] **Step 6: Run focused main-process tests and verify GREEN**

Run:

```bash
npm test -- electron/ptyHost/__tests__/terminalStreamCoordinator.test.ts electron/ptyHost/__tests__/entryFactory.test.ts electron/ptyHost/__tests__/lifecycle.test.ts electron/remote/__tests__/remoteMessages.test.ts
```

Expected: PASS; resize-under-output produces one barrier followed by one contiguous newer tail, and concurrent snapshot requests return the completed current epoch.

- [ ] **Step 7: Commit Task 3**

```bash
git add electron/ptyHost/terminalStreamCoordinator.ts electron/ptyHost/__tests__/terminalStreamCoordinator.test.ts electron/ptyHost/dataFanout.ts electron/ptyHost/entryFactory.ts electron/ptyHost/lifecycle.ts electron/ptyHost/index.ts electron/remote/ptyFanout.ts electron/remote/remoteMessages.ts electron/remote/__tests__/remoteMessages.test.ts
git commit -m "feat(pty): serialize geometry snapshot barriers" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Desktop Visible-Terminal Debounce and IPC Ownership

**Files:**
- Create: `src/terminal/desktopGeometryOwner.ts`
- Create: `tests/terminal/desktopGeometryOwner.test.ts`
- Modify: `src/terminal/usePtyAttachShell.ts:1-33, 90-214, 310-330, 381-430`
- Modify: `src/terminal/shellRegistry.ts:225-287, 425-457`
- Create: `src/terminal/shellStream.ts`
- Modify: `src/terminal/shellTypes.ts:9-34`
- Modify: `src/terminal/shellInput.ts:8-40`
- Modify: `electron/ptyHost/ipcRegistrar.ts:46-82, 213-222`
- Modify: `electron/preload/bridges/ccsmPty.ts:17-24, 32-52, 80-88`
- Modify: `electron/preload/bridges/__tests__/ccsmPty.test.ts`
- Modify: `src/pty.d.ts:9-80`
- Modify: `tests/terminal/shellRegistry.test.ts`
- Modify: `tests/terminal/usePtyAttachShell.spawnCwd.test.tsx`

**Interfaces:**
- Consumes: Task 3 `commitCanonicalGeometry`, ordered `TerminalStreamEvent`.
- Produces:
  - `DESKTOP_GEOMETRY_DEBOUNCE_MS = 140`
  - `createDesktopGeometryOwner(deps): DesktopGeometryOwner`
  - `DesktopGeometryOwner.measure(): void`
  - `DesktopGeometryOwner.flush(): Promise<void>`
  - `DesktopGeometryOwner.dispose(): void`
  - `CcsmPtyApi.resize(sid, cols, rows): Promise<CanonicalTerminalGeometry | null>`
  - `PtyDataEvent` becomes `TerminalStreamEvent`; desktop handles chunk and barrier in one IPC order.
  - `applyShellStreamEvent(shell: Shell, event: TerminalStreamEvent): void`

- [ ] **Step 1: Write failing visible-owner tests**

```ts
it('commits only the last visible measurement after 140 ms', async () => {
  vi.useFakeTimers();
  let visible = true;
  let dimensions = { cols: 120, rows: 30 };
  const commit = vi.fn().mockResolvedValue({ cols: 100, rows: 40, epoch: 1 });
  const owner = createDesktopGeometryOwner({
    isVisible: () => visible,
    readDimensions: () => dimensions,
    commit,
  });

  owner.measure();
  dimensions = { cols: 110, rows: 35 };
  owner.measure();
  dimensions = { cols: 100, rows: 40 };
  owner.measure();
  await vi.advanceTimersByTimeAsync(139);
  expect(commit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(commit).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledWith(100, 40);
});

it('freezes canonical geometry when the shell becomes hidden or unmounts', async () => {
  visible = false;
  owner.measure();
  await vi.advanceTimersByTimeAsync(200);
  owner.dispose();
  expect(commit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run owner tests and verify RED**

Run:

```bash
npm test -- tests/terminal/desktopGeometryOwner.test.ts
```

Expected: FAIL because `desktopGeometryOwner.ts` does not exist.

- [ ] **Step 3: Implement the visible-only debouncer**

```ts
export const DESKTOP_GEOMETRY_DEBOUNCE_MS = 140;

export type DesktopGeometryOwner = {
  measure(): void;
  flush(): Promise<void>;
  dispose(): void;
};

export function createDesktopGeometryOwner(deps: {
  isVisible(): boolean;
  readDimensions(): { cols: number; rows: number };
  commit(cols: number, rows: number): Promise<CanonicalTerminalGeometry | null>;
}): DesktopGeometryOwner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function flush(): Promise<void> {
    if (disposed || !deps.isVisible()) return;
    const { cols, rows } = deps.readDimensions();
    await deps.commit(cols, rows);
  }

  function measure(): void {
    if (disposed || !deps.isVisible()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, DESKTOP_GEOMETRY_DEBOUNCE_MS);
  }

  function dispose(): void {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { measure, flush, dispose };
}
```

- [ ] **Step 4: Replace every desktop resize call with visible-owner commits**

In `usePtyAttachShell`, create one owner per mounted active `sessionId`. Its `isVisible` check must require:

```ts
getTopSid() === sessionId &&
getShell(sessionId)?.wrapper.style.display !== 'none'
```

The ResizeObserver calls `shell.fit.fit()`, reconciles the local viewport, then calls `owner.measure()`. Remove the current 80 ms timer and direct `window.ccsmPty.resize` calls. Cold attach and visited show call `owner.flush()` only after `showShell(sessionId)` has made the shell visible. Hidden font-size changes remain deferred; `showShell` applies pending font size locally, then the visible owner commits.

Do not commit geometry on cleanup. Cleanup only disconnects the observer and calls `owner.dispose()`, retaining the last main-process geometry.

- [ ] **Step 5: Apply ordered barrier events on desktop**

Update preload and `src/pty.d.ts` to expose the Task 1 `TerminalStreamEvent` through the existing `onData` registration. Change `getBufferSnapshot` to return the same geometry-bearing `SessionSnapshotMessage`, and make the cold-start path call `applyShellStreamEvent` so its first paint uses canonical dimensions.

Create `shellStream.ts` and use it from both `shellRegistry.ts` and `shellInput.ts`:

```ts
export function applyShellStreamEvent(shell: Shell, event: TerminalStreamEvent): void {
  if (event.type === 'session.snapshot') {
    shell.term.resize(event.geometry.cols, event.geometry.rows);
    shell.term.reset();
    shell.term.write(event.snapshot);
    return;
  }
  shell.term.write(event.chunk);
}
```

Change `Shell.composingBuffer` from `string[]` to `TerminalStreamEvent[]`. While IME composition is active, append whole events; on `compositionend`, replay them in order through `applyShellStreamEvent`. This prevents a resize barrier from being flattened into a string or overtaken by its live tail. The barrier arrives before coordinator-released new-epoch chunks on the same IPC channel. Keep desktop input wiring unchanged.

- [ ] **Step 6: Verify debounce, hidden-shell ownership, and desktop output**

Run:

```bash
npm test -- tests/terminal/desktopGeometryOwner.test.ts tests/terminal/shellRegistry.test.ts tests/terminal/usePtyAttachShell.spawnCwd.test.tsx electron/preload/bridges/__tests__/ccsmPty.test.ts electron/ptyHost/__tests__/ipcRegistrar.test.ts
```

Expected: PASS; three rapid measurements create one IPC resize after 140 ms, hidden/unmounted shells create none, and barrier/live events remain ordered.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/terminal/desktopGeometryOwner.ts tests/terminal/desktopGeometryOwner.test.ts src/terminal/usePtyAttachShell.ts src/terminal/shellRegistry.ts src/terminal/shellStream.ts src/terminal/shellTypes.ts src/terminal/shellInput.ts electron/ptyHost/ipcRegistrar.ts electron/preload/bridges/ccsmPty.ts electron/preload/bridges/__tests__/ccsmPty.test.ts src/pty.d.ts tests/terminal/shellRegistry.test.ts tests/terminal/usePtyAttachShell.spawnCwd.test.tsx
git commit -m "feat(terminal): make visible desktop own geometry" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Phone Geometry Barriers and Bounded Recovery

**Files:**
- Modify: `src/mobile/terminalSync.ts:1-161`
- Modify: `tests/mobile/terminalSync.test.ts:1-187`
- Modify: `src/mobile/mobileRemoteStore.ts:14-30, 262-297, 361-492`
- Modify: `tests/mobile/mobileRemoteStore.test.ts:1040-1290`
- Modify: `src/mobile/relayClient.ts:55-59, 196-244`
- Modify: `tests/mobile/relayClient.test.ts`

**Interfaces:**
- Consumes: Task 1 `CanonicalTerminalGeometry`, `TerminalChunkMessage`, `SessionSnapshotMessage`; Task 3 barrier ordering.
- Produces:
  - `BufferedTerminalChunk = { geometryEpoch: number; chunk: string }`
  - `TerminalSyncState.geometry: CanonicalTerminalGeometry | null`
  - `TerminalSyncState.buffered: ReadonlyMap<number, BufferedTerminalChunk>`
  - `TerminalRenderEffect = Extract<TerminalSyncEffect, { type: 'installBarrier' | 'write' }>`
  - `TerminalSyncEffect` variants:
    - `{ type: 'installBarrier'; geometry; data: string }`
    - `{ type: 'write'; data: string }`
    - `{ type: 'requestSnapshot'; sid: string; reason: TerminalRecoveryReason }`
    - `{ type: 'diagnostic'; reason: TerminalRecoveryReason }`
  - `TerminalRecoveryReason = 'sequence_gap' | 'future_epoch' | 'invalid_geometry' | 'buffer_overflow' | 'snapshot_mismatch'`

- [ ] **Step 1: Write failing geometry-recovery reducer tests**

```ts
it('installs one newer barrier then drains only its contiguous epoch tail', () => {
  let state = beginTerminalSync('s1');
  state = applyTerminalChunk(state, chunk(11, 2, 'eleven')).state;
  state = applyTerminalChunk(state, chunk(10, 2, 'ten')).state;
  const applied = applyTerminalSnapshot(
    state,
    snapshot(9, { cols: 120, rows: 30, epoch: 2 }, 'screen'),
  );
  expect(applied.effects).toEqual([
    {
      type: 'installBarrier',
      geometry: { cols: 120, rows: 30, epoch: 2 },
      data: 'screen',
    },
    { type: 'write', data: 'ten' },
    { type: 'write', data: 'eleven' },
  ]);
  expect(applied.state).toMatchObject({
    phase: 'live',
    lastSeq: 11,
    geometry: { cols: 120, rows: 30, epoch: 2 },
  });
});

it('keeps the last frame and requests one snapshot for a future epoch without its barrier', () => {
  const live = syncedState('s1', 8, { cols: 120, rows: 30, epoch: 1 });
  const result = applyTerminalChunk(live, chunk(9, 2, 'future'));
  expect(result.effects).toContainEqual({
    type: 'requestSnapshot',
    sid: 's1',
    reason: 'future_epoch',
  });
  expect(result.effects.some((effect) => effect.type === 'installBarrier')).toBe(false);
  expect(result.state.phase).toBe('syncing');
});

it('makes overflow observable and stays syncing with at most 256 chunks', () => {
  let state = beginTerminalSync('s1');
  let lastEffects: TerminalSyncEffect[] = [];
  for (let seq = 1; seq <= 257; seq += 1) {
    const result = applyTerminalChunk(state, chunk(seq, 1, String(seq)));
    state = result.state;
    lastEffects = result.effects;
  }
  expect(state.buffered.size).toBe(256);
  expect(state.phase).toBe('syncing');
  expect(lastEffects).toContainEqual({ type: 'diagnostic', reason: 'buffer_overflow' });
});
```

- [ ] **Step 2: Run reducer tests and verify RED**

Run:

```bash
npm test -- tests/mobile/terminalSync.test.ts
```

Expected: FAIL because state and messages do not carry geometry epochs and `installBarrier` is undefined.

- [ ] **Step 3: Extend the existing reducer rather than creating another state machine**

Keep `MAX_BUFFERED_TERMINAL_CHUNKS = 256`. Change the reducer in place:

```ts
export type TerminalSyncState = {
  sid: string | null;
  phase: TerminalSyncPhase;
  geometry: CanonicalTerminalGeometry | null;
  lastSeq: number;
  snapshotRequested: boolean;
  buffered: ReadonlyMap<number, BufferedTerminalChunk>;
};
```

Apply these rules in order:

1. Ignore a different `sid`, unsafe sequence, duplicate/stale sequence, or stale epoch.
2. A live chunk for the installed epoch and exactly `lastSeq + 1` emits one `write`.
3. A same-epoch sequence gap buffers and requests one snapshot.
4. A future epoch buffers and requests one snapshot without changing the installed geometry.
5. Overflow evicts the highest/farthest sequence, emits `diagnostic: buffer_overflow`, remains syncing, and requests a fresh snapshot.
6. Reject malformed geometry before any `installBarrier`.
7. Ignore stale/superseded barriers.
8. A valid newer barrier emits exactly one `installBarrier`, discards buffered sequences `<= snapshot.seq`, drains only contiguous chunks whose `geometryEpoch === snapshot.geometry.epoch`, and requests recovery if anything incompatible remains.

No invalid path emits `installBarrier`, so the last valid xterm frame stays visible.

- [ ] **Step 4: Update store render batching and diagnostics**

Change `TerminalRenderBatch.effects` to `TerminalRenderEffect[]` and define:

```ts
export type TerminalRenderEffect = Extract<
  TerminalSyncEffect,
  { type: 'installBarrier' | 'write' }
>;
```

`isRenderEffect` recognizes those two variants. `requestSnapshot` continues to send `{ type: 'session.snapshot', sid }`; remove `session.resize` from `RecoveryMessage` and `isRecoveryMessage` in `relayClient.ts`. Log diagnostics with:

```ts
console.warn(`[mobile-terminal-sync] ${effect.reason} sid=${result.state.sid ?? 'none'}`);
```

Do not clear drafts, composer state, pending submissions, or terminal batches on diagnostics.

- [ ] **Step 5: Run reducer/store/relay tests and verify GREEN**

Run:

```bash
npm test -- tests/mobile/terminalSync.test.ts tests/mobile/mobileRemoteStore.test.ts tests/mobile/relayClient.test.ts
```

Expected: PASS for stale, duplicate, future epoch, malformed geometry, overflow, superseded barrier, reconnect, and session-switch cases; the reducer remains the sole phone terminal sync state.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/mobile/terminalSync.ts tests/mobile/terminalSync.test.ts src/mobile/mobileRemoteStore.ts tests/mobile/mobileRemoteStore.test.ts src/mobile/relayClient.ts tests/mobile/relayClient.test.ts
git commit -m "feat(mobile): enforce geometry snapshot barriers" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 6: Canonical Phone Grid, Physical Viewport, Pan, and Anchors

**Files:**
- Modify: `src/mobile/mobileTerminalAdapter.ts:1-297`
- Modify: `tests/mobile/mobileTerminalAdapter.test.ts:1-460`

**Interfaces:**
- Consumes: Task 5 `installBarrier` and `write` effects.
- Produces:
  - `LogicalScrollMetrics = { maximumTop: number; currentTop: number; visibleRows: number; totalRows: number }`
  - `HorizontalViewportMetrics = { viewportWidth: number; contentWidth: number; offset: number; maximumOffset: number }`
  - `TerminalHistoryAnchor = { mode: 'follow' } | { mode: 'history'; distanceFromBottom: number }`
  - `MobileTerminalViewportState = { vertical: LogicalScrollMetrics; horizontal: HorizontalViewportMetrics; geometry: CanonicalTerminalGeometry | null }`
  - Adapter methods:
    - `activateSession(sid: string | null): void`
    - `apply(effects: readonly TerminalRenderEffect[]): void`
    - `getViewportState(): MobileTerminalViewportState`
    - `subscribeViewport(listener: () => void): () => void`
    - `scrollToLine(line: number): void`
    - `scrollByLines(amount: number): void`
    - `captureHistoryAnchor(): TerminalHistoryAnchor`
    - `restoreHistoryAnchor(anchor: TerminalHistoryAnchor): void`
    - `setHorizontalOffset(offset: number): void`
    - `syncPhysicalViewport(): void`
    - `fit(force?: boolean): void` retained through Task 7 as a compatibility alias for `syncPhysicalViewport()`; it never calls xterm resize and Task 8 removes the obsolete caller and alias.
    - `copySelection(): Promise<void>`
    - `serialize(): string`
    - `dispose(): void`

- [ ] **Step 1: Write failing canonical-grid and viewport tests**

```ts
it('resizes xterm only from installBarrier and never from visual viewport changes', () => {
  const { adapter, terminal } = createHarness();
  adapter.apply([{
    type: 'installBarrier',
    geometry: { cols: 132, rows: 41, epoch: 4 },
    data: 'screen',
  }]);
  expect(terminal.resize).toHaveBeenCalledWith(132, 41);
  expect(terminal.reset).toHaveBeenCalledOnce();
  expect(terminal.write).toHaveBeenCalledWith('screen');

  terminal.resize.mockClear();
  visualViewport.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('orientationchange'));
  vi.runAllTimers();
  expect(terminal.resize).not.toHaveBeenCalled();
});

it('projects xterm buffer state as logical scroll metrics', () => {
  terminal.buffer.active.baseY = 300;
  terminal.buffer.active.viewportY = 220;
  terminal.rows = 30;
  expect(adapter.getViewportState().vertical).toEqual({
    maximumTop: 300,
    currentTop: 220,
    visibleRows: 30,
    totalRows: 330,
  });
});

it('captures and restores distance from bottom without focusing xterm', () => {
  terminal.buffer.active.baseY = 300;
  terminal.buffer.active.viewportY = 220;
  expect(adapter.captureHistoryAnchor()).toEqual({
    mode: 'history',
    distanceFromBottom: 80,
  });
  terminal.buffer.active.baseY = 350;
  adapter.restoreHistoryAnchor({ mode: 'history', distanceFromBottom: 80 });
  expect(terminal.scrollToLine).toHaveBeenCalledWith(270);
  expect(terminal.focus).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
npm test -- tests/mobile/mobileTerminalAdapter.test.ts
```

Expected: FAIL because logical viewport methods and `installBarrier` handling are absent.

- [ ] **Step 3: Remove phone FitAddon ownership and extend the xterm structural API**

Remove FitAddon construction, dimension-proposal timers, and `onResize`. Retain `fit(force?)` temporarily as a no-argument-compatible alias that only calls `syncPhysicalViewport`; this keeps Task 6 independently type-safe until Task 8 removes PhoneShell's old `fit(true)` call. Add these xterm members to `MobileXtermTerminal`:

```ts
readonly buffer: {
  active: { baseY: number; viewportY: number };
};
scrollToLine(line: number): void;
scrollLines(amount: number): void;
scrollToBottom(): void;
onScroll(handler: () => void): { dispose(): void };
```

Keep `disableStdin: true`, helper-textarea hardening, SerializeAddon, Unicode11Addon, WebLinksAddon, and no `onData`.

- [ ] **Step 4: Implement canonical effects and physical viewport state**

```ts
function apply(effects: readonly TerminalRenderEffect[]): void {
  const anchor = captureHistoryAnchor();
  for (const effect of effects) {
    if (effect.type === 'installBarrier') {
      terminal.resize(effect.geometry.cols, effect.geometry.rows);
      geometry = effect.geometry;
      terminal.reset();
      terminal.write(effect.data);
    } else {
      terminal.write(effect.data);
    }
  }
  restoreHistoryAnchor(anchor);
  syncPhysicalViewport();
}

function logicalScrollMetrics(): LogicalScrollMetrics {
  const maximumTop = Math.max(0, terminal.buffer.active.baseY);
  const currentTop = Math.min(maximumTop, Math.max(0, terminal.buffer.active.viewportY));
  return {
    maximumTop,
    currentTop,
    visibleRows: terminal.rows,
    totalRows: maximumTop + terminal.rows,
  };
}
```

Measure physical `viewportWidth` from the host's client width and `contentWidth` from the canonical xterm screen's scroll width/bounding box. Set the host's horizontal `scrollLeft` only through `setHorizontalOffset`, clamped to `maximumOffset`. Register a passive host `scroll` listener so native touch pan updates subscribers and per-session horizontal state. On visual viewport, window resize, orientation, browser zoom, and keyboard changes, update `--app-height`, `--app-offset-top`, recompute widths, and clamp pan; never call `terminal.resize`.

Use xterm public `scrollToLine`, `scrollLines`, and `scrollToBottom`; do not read or write `.xterm-viewport.scrollTop`.

- [ ] **Step 5: Implement per-session anchors inside the long-lived adapter**

`activateSession(nextSid)` captures the current session's logical anchor and horizontal offset into maps before switching. A new sid starts with `{ mode: 'follow' }` and offset 0. `apply` captures the active anchor before an installed barrier and restores after the snapshot plus contiguous writes in that batch. Live output calls `scrollToBottom()` only in follow mode. History mode keeps its distance from bottom, clamped to available history.

- [ ] **Step 6: Run adapter tests and verify GREEN**

Run:

```bash
npm test -- tests/mobile/mobileTerminalAdapter.test.ts
```

Expected: PASS; only barriers resize xterm, physical changes clamp pan, logical anchors survive output/barriers, and no focus/onData calls occur.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/mobile/mobileTerminalAdapter.ts tests/mobile/mobileTerminalAdapter.test.ts
git commit -m "feat(mobile): separate canonical grid from viewport" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 7: Pure Scrollbar Metrics and Persistent Accessible Component

**Files:**
- Create: `src/mobile/terminalScrollbar.ts`
- Create: `tests/mobile/terminalScrollbar.test.ts`
- Create: `src/mobile/components/MobileTerminalScrollbar.tsx`
- Create: `tests/mobile/MobileTerminalScrollbar.test.tsx`

**Interfaces:**
- Consumes: Task 6 `LogicalScrollMetrics`.
- Produces:
  - `MIN_TERMINAL_THUMB_PX = 44`
  - `TerminalScrollbarProjection = { disabled: boolean; maximumTop: number; trackHeight: number; thumbHeight: number; maximumThumbOffset: number; thumbOffset: number }`
  - `projectTerminalScrollbar(metrics, trackHeight): TerminalScrollbarProjection`
  - `lineForThumbOffset(projection, thumbOffset): number`
  - `lineForTrackPoint(projection, pointerY): number`
  - `MobileTerminalScrollbarProps = { label: string; controlsId: string; metrics: LogicalScrollMetrics; onScrollTo(line: number): void; onScrollBy(amount: number): void }`

- [ ] **Step 1: Write failing pure-math tests**

```ts
it('keeps an empty-scrollback rail visible with a full-height disabled thumb', () => {
  expect(projectTerminalScrollbar({
    maximumTop: 0,
    currentTop: 0,
    visibleRows: 30,
    totalRows: 30,
  }, 300)).toEqual({
    disabled: true,
    maximumTop: 0,
    trackHeight: 300,
    thumbHeight: 300,
    maximumThumbOffset: 0,
    thumbOffset: 0,
  });
});

it('clamps the thumb to at least 44 CSS pixels and maps both directions', () => {
  const projection = projectTerminalScrollbar({
    maximumTop: 970,
    currentTop: 485,
    visibleRows: 30,
    totalRows: 1000,
  }, 200);
  expect(projection.thumbHeight).toBe(44);
  expect(lineForThumbOffset(projection, projection.maximumThumbOffset / 2)).toBe(485);
});
```

- [ ] **Step 2: Run pure tests and verify RED**

Run:

```bash
npm test -- tests/mobile/terminalScrollbar.test.ts
```

Expected: FAIL because the projection module does not exist.

- [ ] **Step 3: Implement complete pure projection and inverse mapping**

```ts
export const MIN_TERMINAL_THUMB_PX = 44;

export function projectTerminalScrollbar(
  metrics: LogicalScrollMetrics,
  trackHeight: number,
): TerminalScrollbarProjection {
  const safeTrack = Math.max(0, trackHeight);
  if (metrics.maximumTop <= 0 || safeTrack === 0) {
    return {
      disabled: true,
      maximumTop: 0,
      trackHeight: safeTrack,
      thumbHeight: safeTrack,
      maximumThumbOffset: 0,
      thumbOffset: 0,
    };
  }
  const proportional = safeTrack * (metrics.visibleRows / metrics.totalRows);
  const thumbHeight = Math.min(safeTrack, Math.max(MIN_TERMINAL_THUMB_PX, proportional));
  const maximumThumbOffset = Math.max(0, safeTrack - thumbHeight);
  const thumbOffset = maximumThumbOffset * (metrics.currentTop / metrics.maximumTop);
  return {
    disabled: false,
    maximumTop: metrics.maximumTop,
    trackHeight: safeTrack,
    thumbHeight,
    maximumThumbOffset,
    thumbOffset,
  };
}

export function lineForThumbOffset(
  projection: TerminalScrollbarProjection,
  thumbOffset: number,
): number {
  if (projection.disabled || projection.maximumThumbOffset === 0) return 0;
  const clamped = Math.min(projection.maximumThumbOffset, Math.max(0, thumbOffset));
  return Math.round(projection.maximumTop * (clamped / projection.maximumThumbOffset));
}

export function lineForTrackPoint(
  projection: TerminalScrollbarProjection,
  pointerY: number,
): number {
  return lineForThumbOffset(projection, pointerY - projection.thumbHeight / 2);
}
```

- [ ] **Step 4: Write failing component interaction and accessibility tests**

```tsx
it('captures pointer drag and maps it to a logical line without focusing terminal input', () => {
  const onScrollTo = vi.fn();
  render(<MobileTerminalScrollbar label="Terminal output" controlsId="terminal-grid" metrics={metrics} onScrollTo={onScrollTo} onScrollBy={vi.fn()} />);
  const rail = screen.getByRole('scrollbar', { name: 'Terminal output scroll position' });
  vi.spyOn(rail, 'setPointerCapture');
  fireEvent.pointerDown(screen.getByTestId('mobile-terminal-thumb'), { pointerId: 7, clientY: 40 });
  fireEvent.pointerMove(rail, { pointerId: 7, clientY: 160 });
  expect(rail.setPointerCapture).toHaveBeenCalledWith(7);
  expect(onScrollTo).toHaveBeenCalled();
  expect(document.querySelector('.xterm-helper-textarea')).not.toBe(document.activeElement);
});

it.each([
  ['ArrowUp', -1],
  ['ArrowDown', 1],
  ['PageUp', -24],
  ['PageDown', 24],
])('maps %s to logical scrolling', (key, amount) => {
  fireEvent.keyDown(scrollbar, { key });
  expect(onScrollBy).toHaveBeenCalledWith(amount);
});
```

- [ ] **Step 5: Implement the persistent component**

Render a `div` with `role="scrollbar"`, `tabIndex={0}`, `aria-controls={controlsId}`, `aria-orientation="vertical"`, `aria-valuemin={0}`, `aria-valuemax`, `aria-valuenow`, `aria-disabled={projection.disabled}`, and `aria-label={`${label} scroll position`}`. Include visually hidden text that says `No terminal history` while disabled so status is not color-only. Use a `ResizeObserver` for track height. Pointer-down on the thumb records the drag origin and calls `currentTarget.setPointerCapture(pointerId)`; pointer move maps through `lineForThumbOffset`; pointer-up releases capture. Pointer-down on the track maps through `lineForTrackPoint`. Keyboard mappings are Arrow Up/Down = 1 line, Page Up/Down = `visibleRows - 1`, Home = 0, End = `maximumTop`.

Do not call `focus()` in pointer handlers. Native keyboard tab focus may land on the scrollbar for accessibility, but no action may focus xterm or its helper textarea.

- [ ] **Step 6: Run scrollbar tests and verify GREEN**

Run:

```bash
npm test -- tests/mobile/terminalScrollbar.test.ts tests/mobile/MobileTerminalScrollbar.test.tsx
```

Expected: PASS for disabled rail, 44 px minimum thumb, drag, capture, track jump, keyboard mapping, and ARIA values.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/mobile/terminalScrollbar.ts tests/mobile/terminalScrollbar.test.ts src/mobile/components/MobileTerminalScrollbar.tsx tests/mobile/MobileTerminalScrollbar.test.tsx
git commit -m "feat(mobile): add accessible terminal scrollbar" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 8: PhoneShell and MobileTerminal Integration, History, and CSS

**Files:**
- Modify: `src/mobile/components/MobileTerminal.tsx:1-80`
- Modify: `tests/mobile/MobileTerminal.test.tsx:1-263`
- Modify: `src/mobile/components/PhoneShell.tsx:30-57, 93-168, 267-273`
- Modify: `tests/mobile/PhoneShell.test.tsx:700-800`
- Modify: `src/mobile/mobile.css:14-30, 59-89, 205-220, 312-366`
- Modify: `src/mobile/testBridge.d.ts:1-37`
- Modify: `tests/mobile/testBridge.test.tsx:98-240`
- Modify: `tests/mobile/bootstrap.test.tsx:193-230`

**Interfaces:**
- Consumes: Task 6 adapter state/actions and Task 7 scrollbar component.
- Produces:
  - `MobileTerminalProps.sessionId: string | null`
  - Test bridge methods `getGeometry()`, `getViewportState()`, and existing `serializeTerminal()`/`getSyncState()`.
  - DOM structure `.mobile-terminal-viewport > .mobile-terminal-grid + .mobile-terminal-scrollbar`.

- [ ] **Step 1: Write failing integration tests**

```tsx
it('activates sessions without remounting xterm and composes the persistent rail', () => {
  const { rerender } = render(
    <MobileTerminal sessionId="s1" batch={null} adapterRef={adapterRef} createAdapter={factory} />,
  );
  rerender(
    <MobileTerminal sessionId="s2" batch={barrierBatch} adapterRef={adapterRef} createAdapter={factory} />,
  );
  expect(factory).toHaveBeenCalledOnce();
  expect(adapter.activateSession).toHaveBeenCalledWith('s2');
  expect(screen.getByRole('scrollbar')).toBeVisible();
});

it('keeps canonical geometry fixed across orientation and keyboard viewport changes', () => {
  render(<PhoneShell client={client} createAdapter={factory} />);
  client.emitMessage(snapshotMessage({ cols: 132, rows: 41, epoch: 2 }));
  visualViewport.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('orientationchange'));
  expect(client.sent.some((message) => message.type === 'session.resize')).toBe(false);
  expect(window.__ccsmMobileTest?.getGeometry()).toEqual({ cols: 132, rows: 41, epoch: 2 });
});
```

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
npm test -- tests/mobile/MobileTerminal.test.tsx tests/mobile/PhoneShell.test.tsx tests/mobile/testBridge.test.tsx tests/mobile/bootstrap.test.tsx
```

Expected: FAIL because session activation, viewport subscription, scrollbar composition, and bridge methods are missing.

- [ ] **Step 3: Integrate the long-lived adapter and scrollbar**

`MobileTerminal` creates the adapter once against `.mobile-terminal-grid`. On `sessionId` changes it calls `adapter.activateSession(sessionId)`. Subscribe to adapter viewport state with `useSyncExternalStore` or a local subscription callback; pass vertical metrics and public scroll actions to `MobileTerminalScrollbar`. Apply each numbered render batch once, then consume it exactly as today.

Representative structure:

```tsx
return (
  <div className="mobile-terminal-viewport" aria-label="Terminal output">
    <div id="mobile-terminal-grid" ref={gridRef} className="mobile-terminal-grid" />
    <MobileTerminalScrollbar
      label="Terminal output"
      controlsId="mobile-terminal-grid"
      metrics={viewport.vertical}
      onScrollTo={adapter.scrollToLine}
      onScrollBy={adapter.scrollByLines}
    />
  </div>
);
```

The grid remains mounted during sync, reconnect, and session switching.

- [ ] **Step 4: Remove all phone resize transport code**

`PhoneShell` passes `sessionId` and no `onResize`. Delete `handleResize`, `dimensionsRef`, and the session-switch `fit(true)` effect, then remove the Task 6 compatibility `fit` alias from `MobileTerminalAdapter`. Remove `session.resize` from normal client production sends while retaining the Task 2 desktop compatibility no-op for already-deployed old phones.

- [ ] **Step 5: Apply layout and interaction CSS**

Use these required dimensions and overflow rules:

```css
.mobile-terminal-viewport {
  grid-area: terminal;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: auto hidden;
  padding: 6px 24px 6px 6px;
  background: #000;
  user-select: text;
  -webkit-user-select: text;
  touch-action: pan-x pan-y;
}

.mobile-terminal-grid {
  min-width: max-content;
  height: 100%;
}

.mobile-terminal-grid .xterm {
  height: 100%;
}

.mobile-terminal-viewport::after {
  content: '';
  position: sticky;
  right: 24px;
  width: 12px;
  pointer-events: none;
  background: linear-gradient(to right, transparent, rgb(0 0 0 / 55%));
}

.mobile-terminal-scrollbar {
  position: absolute;
  inset: 0 0 0 auto;
  width: 24px;
  touch-action: none;
}

.mobile-terminal-scrollbar__thumb {
  position: absolute;
  right: 4px;
  width: 16px;
  min-height: 44px;
}

@media (forced-colors: active) {
  .mobile-terminal-scrollbar {
    border-left: 1px solid CanvasText;
  }
  .mobile-terminal-scrollbar__thumb {
    background: Highlight;
  }
}
```

Preserve safe-area padding, the fixed visual-viewport shell, composer placement, native text selection/copy, and horizontal overflow affordance.

- [ ] **Step 6: Extend the read-only test bridge**

Expose JSON-safe copies only:

```ts
export type MobileTestBridge = {
  serializeTerminal(): string;
  getSyncState(): MobileTestSyncState;
  getGeometry(): CanonicalTerminalGeometry | null;
  getViewportState(): MobileTerminalViewportState;
};
```

Do not expose relay secrets, client, raw store, drafts, or encrypted frames.

- [ ] **Step 7: Run integration tests and verify GREEN**

Run:

```bash
npm test -- tests/mobile/MobileTerminal.test.tsx tests/mobile/PhoneShell.test.tsx tests/mobile/testBridge.test.tsx tests/mobile/bootstrap.test.tsx tests/mobile/mobileTerminalAdapter.test.ts tests/mobile/MobileTerminalScrollbar.test.tsx
```

Expected: PASS for first-mount batch, no remount, session/reconnect anchors, canonical geometry persistence, horizontal pan, scrollbar actions, no phone resize, and no helper-textarea focus.

Add an explicit exited-session assertion in `PhoneShell.test.tsx`: exiting the selected session keeps the last rendered frame and installed canonical geometry, disables input through the existing navigator/session state, and never resets xterm to phone dimensions.

- [ ] **Step 8: Commit Task 8**

```bash
git add src/mobile/components/MobileTerminal.tsx tests/mobile/MobileTerminal.test.tsx src/mobile/components/PhoneShell.tsx tests/mobile/PhoneShell.test.tsx src/mobile/mobile.css src/mobile/testBridge.d.ts tests/mobile/testBridge.test.tsx tests/mobile/bootstrap.test.tsx
git commit -m "feat(mobile): integrate independent terminal viewport" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 9: Deterministic Local/Public E2E and Exact Parity

**Files:**
- Modify: `scripts/fixtures/mobile-remote-pty-fixture.mjs:1-103`
- Modify: `scripts/probe-helpers/mobileRemoteHarness.mjs:215-420`
- Modify: `scripts/harness-e2e-mobile-terminal-sync.mjs:1-520`
- Modify: `scripts/harness-e2e-mobile-remote-visual.mjs:1-360`
- Modify: `scripts/harness-e2e-mobile-remote-relay.mjs`
- Create: `scripts/harness-e2e-mobile-desktop-ownership.mjs`
- Modify: `scripts/run-all-e2e.mjs:1-18` only if comments need the new cases; discovery already includes all harnesses.

**Interfaces:**
- Consumes: Task 1 wire shapes, Task 3 epoch barrier, Task 8 test bridge.
- Produces deterministic harness helpers:
  - `desktop.commitGeometry(sid, cols, rows)`
  - `desktop.delayNextSnapshot(sid)`
  - `desktop.getGeometry(sid)`
  - `desktop.sentTerminalEvents`
  - existing `CCSM_RELAY_URL` local/public selection remains unchanged.

- [ ] **Step 1: Update the simulated desktop contract and write a failing harness case**

Give each simulated session `{ geometry: { cols, rows, epoch }, seq, headless }`. `sendRawPty` includes `geometryEpoch`; `sendSnapshotNow` includes the complete geometry. `commitGeometry` increments epoch once, resizes the authoritative headless terminal, captures one snapshot barrier, then releases queued output.

Add a `resize-under-output` case that:

1. starts at 132x41;
2. writes fixture chunks 1-50;
3. begins a desktop resize to 100x35 while chunks 51-80 continue;
4. delays the barrier snapshot while chunks race;
5. releases the barrier and writes the remainder;
6. asserts one epoch-1 barrier, no duplicate/gap, and exact serialized parity.

Run before production harness helpers are complete:

```bash
npm run build
node scripts/harness-e2e-mobile-terminal-sync.mjs
```

Expected: FAIL in `resize-under-output` because the simulator and bridge do not yet carry the complete geometry/barrier assertions.

- [ ] **Step 2: Extend the ANSI fixture without weakening existing markers**

Keep the existing long lines, carriage-return progress, erase, clear/home, and alternate-screen transitions. Add cursor-addressing and insert/delete-line chunks with unique surviving markers:

```js
`\x1b[5;10H${FIXTURE_CURSOR_MARKER}`,
`\x1b[2L${FIXTURE_INSERT_LINE_MARKER}\r\n`,
`\x1b[1M${FIXTURE_DELETE_LINE_MARKER}\r\n`,
```

Update surviving/erased marker arrays so every expected marker has an exact occurrence assertion.

- [ ] **Step 3: Add exact recovery and desktop-unaffected assertions**

Cover:

- snapshot/live overlap at a resize barrier;
- duplicate and stale chunks;
- missing sequence;
- future epoch without barrier;
- malformed and overflow recovery;
- superseded delayed barrier;
- reconnect and session switch;
- exact phone/reference `SerializeAddon.serialize()` parity at identical canonical dimensions;
- desktop geometry remains 132x41 across phone portrait, landscape, keyboard open/close, and browser zoom;
- phone sent-message log contains zero `session.resize`.

Create `harness-e2e-mobile-desktop-ownership.mjs` to automate the real-Electron donor reproduction methodology. Launch CCSM with `launchCcsmIsolated`, prepend a platform-specific wrapper for `scripts/fixtures/stub-claude.mjs` to `PATH`, set `CCSM_MOBILE_REMOTE_RELAY_URL` to the local Wrangler URL, create and show one real desktop session, then obtain the pairing URL through `window.ccsmMobileRemote.getPairingUrl()`. Insert `?ccsmTest=1` before the pairing URL's `#pair=` fragment so the phone geometry bridge is available without changing the pairing identity.

Use this exact cross-viewport assertion after setup:

```js
async function assertPhoneDoesNotOwnPty({ win, phone, sid }) {
  const before = await win.evaluate((sessionId) => window.ccsmPty.get(sessionId), sid);
  assert.deepEqual(before.geometry, { cols: 132, rows: 41, epoch: 1 });

  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.evaluate(() => window.visualViewport?.dispatchEvent(new Event('resize')));
  await phone.setViewportSize({ width: 844, height: 390 });
  await phone.evaluate(() => window.dispatchEvent(new Event('orientationchange')));

  const [after, phoneGeometry] = await Promise.all([
    win.evaluate((sessionId) => window.ccsmPty.get(sessionId), sid),
    phone.evaluate(() => window.__ccsmMobileTest.getGeometry()),
  ]);
  assert.deepEqual(after.geometry, before.geometry);
  assert.deepEqual(phoneGeometry, before.geometry);
}
```

The phone physical viewport deliberately differs from the 132x41 canonical grid. The harness must not define `phoneDims`, call `setSessionDimensions`, or initialize its authoritative headless terminal from any phone FitAddon measurement.

- [ ] **Step 4: Add pan and scrollbar Playwright assertions**

In the visual harness, assert:

```js
assert.equal(await page.evaluate(() => window.__ccsmMobileTest.getGeometry().cols), 132);
await page.locator('.mobile-terminal-viewport').evaluate((element) => { element.scrollLeft = 200; });
assert.ok((await page.evaluate(() => window.__ccsmMobileTest.getViewportState().horizontal.offset)) > 0);

const rail = page.getByRole('scrollbar', { name: 'Terminal output scroll position' });
await rail.click({ position: { x: 12, y: 80 } });
assert.ok(Number(await rail.getAttribute('aria-valuenow')) > 0);
```

Also drag the thumb with Playwright pointer actions, assert minimum 44 px height, disabled full-height state with no scrollback, and verify `document.activeElement` is never `.xterm-helper-textarea`. Select terminal text and use the browser copy path without opening the composer keyboard.

- [ ] **Step 5: Run deterministic local E2E and verify GREEN**

Run:

```bash
npm run build
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs
node scripts/harness-e2e-mobile-remote-relay.mjs
node scripts/harness-e2e-mobile-desktop-ownership.mjs
```

Expected: each harness prints PASS for every case and exits 0; exact parity is byte/ANSI serialization equality, not substring equality.

- [ ] **Step 6: Run the same harnesses against the public relay**

Run:

```bash
test -n "$CCSM_RELAY_URL"
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs
```

Expected: same PASS results. This uses an already approved relay URL; it does not deploy or mutate relay infrastructure.

- [ ] **Step 7: Commit Task 9**

```bash
git add scripts/fixtures/mobile-remote-pty-fixture.mjs scripts/probe-helpers/mobileRemoteHarness.mjs scripts/harness-e2e-mobile-terminal-sync.mjs scripts/harness-e2e-mobile-remote-visual.mjs scripts/harness-e2e-mobile-remote-relay.mjs scripts/harness-e2e-mobile-desktop-ownership.mjs scripts/run-all-e2e.mjs
git commit -m "test(mobile): prove geometry barrier parity" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 10: Documentation, Integration, Final Gates, and Physical Phone

**Files:**
- Cherry-pick/integrate: commit `61af85f1` from branch `jiahui-gu-fix-mobile-send-submit`
- Integration overlap: `electron/ptyHost/lifecycle.ts:144-205` (`submit`, adjacent canonical resize), `electron/ptyHost/index.ts:84-90` (`submitPtySession`), `electron/remote/remoteMessages.ts:104-135` (`session.submit`)
- Send regression tests: `electron/ptyHost/__tests__/lifecycle.test.ts` (`describe('submit')`), `electron/remote/__tests__/remoteMessages.test.ts` (`session.submit` acknowledgment ordering), `tests/mobile/mobileRemoteStore.test.ts` (acknowledged Send input isolation), `scripts/harness-e2e-mobile-remote-relay.mjs` (Send without follow-up `session.input`)
- Modify: `README.md:75-86`
- Modify: `docs/README.md:1-20`
- Modify only if implementation exposes a new tracked debt: `DEBT.md`
- Verify unchanged: `package.json:3`, `package-lock.json` root version fields
- Verify implementation diff across all files from Tasks 1-9

**Interfaces:**
- Consumes: all prior task contracts and deterministic harnesses; Task 2's selectively reused ownership evidence from `b730487c`; separate Send FIFO-barrier fix `61af85f1`.
- Produces: an integrated branch retaining `submitPtySession(sid, draft): Promise<PtySubmitResult>`, documented ownership/recovery behavior, and release-blocking combined acceptance evidence.

- [ ] **Step 1: Verify and cherry-pick the separate Send root fix**

Run:

```bash
git merge-base --is-ancestor 96cf4114 61af85f1
git diff --check 96cf4114 61af85f1
git show --stat --oneline 61af85f1
git cherry-pick -x 61af85f1
```

Expected: the ancestry and whitespace checks exit 0; the stat lists exactly the seven Send-fix files above. The cherry-pick may report conflicts in `lifecycle.ts`, `index.ts`, `remoteMessages.ts`, or their tests because Tasks 2-5 deliberately refactor the same PTY/snapshot surfaces.

- [ ] **Step 2: Resolve any integration conflicts while preserving both root-cause contracts**

Keep the viewport coordinator and epoch-barrier code from Tasks 2-5. Preserve these exact Send semantics from `61af85f1`:

```ts
export async function submit(
  sessions: Map<string, Entry>,
  sid: string,
  draft: string,
): Promise<PtySubmitResult> {
  if (draft.length === 0) return 'invalid_submission';
  const entry = sessions.get(sid);
  if (!entry) return 'session_not_found';

  try {
    await new Promise<void>((resolve, reject) => {
      try {
        entry.headless.write('', () => resolve());
      } catch (error) {
        reject(error);
      }
    });
  } catch {
    return 'pty_write_failed';
  }
  if (sessions.get(sid) !== entry) return 'session_not_found';

  const payload = preparePastePayload(
    draft,
    entry.headless.modes?.bracketedPasteMode === true,
  );
  try {
    entry.pty.write(`${payload}\r`);
    return 'ok';
  } catch {
    return 'pty_write_failed';
  }
}
```

There is no timeout fallback on this Send parser barrier: acknowledgment waits for the FIFO callback or an explicit write failure. Keep the post-await session identity check so reload/kill cannot submit to a stale or replacement PTY. Keep the prepared draft and Enter in one `pty.write` call.

The public surfaces remain async:

```ts
export const submitPtySession = (
  sid: string,
  draft: string,
): Promise<L.PtySubmitResult> => L.submit(sessions, sid, draft);

const result = await submitPtySession(message.sid as string, message.draft as string);
```

After resolving, run:

```bash
git add electron/ptyHost/lifecycle.ts electron/ptyHost/index.ts electron/ptyHost/__tests__/lifecycle.test.ts electron/remote/remoteMessages.ts electron/remote/__tests__/remoteMessages.test.ts tests/mobile/mobileRemoteStore.test.ts scripts/harness-e2e-mobile-remote-relay.mjs
git cherry-pick --continue
```

Expected: commit `61af85f1` is integrated after the viewport commits, with both async Send acknowledgment and geometry ownership intact.

- [ ] **Step 3: Run focused combined Send and viewport regression tests**

Run:

```bash
npm test -- electron/ptyHost/__tests__/lifecycle.test.ts electron/remote/__tests__/remoteMessages.test.ts tests/mobile/mobileRemoteStore.test.ts tests/mobile/terminalSync.test.ts tests/mobile/PhoneShell.test.tsx
npm run build
node scripts/harness-e2e-mobile-remote-relay.mjs
```

Expected: tests pass for FIFO parser ordering, barrier-write failure, removed/replaced entry races, awaited acknowledgment, no masking `session.input`, no phone PTY resize, and epoch-aware terminal sync. The relay harness reports that Send never requires a follow-up `session.input`.

- [ ] **Step 4: Document the implemented user-visible behavior**

Update the Mobile Remote README section to state:

- the visible desktop terminal determines PTY columns/rows;
- phone orientation and keyboard changes resize only the physical viewport;
- phone users pan horizontally and use the persistent right-edge logical scrollbar;
- reconnect and session switching retain the last valid frame and history anchor;
- the phone terminal remains read-only and the composer is the only keyboard entry.

Add the approved design and this plan to `docs/README.md`. Do not rewrite the approved spec.

- [ ] **Step 5: Run the complete static and unit gates**

Run:

```bash
node --version
npm run typecheck
npm run lint
npm test
```

Expected:

- Node reports `v22.x` or newer.
- Typecheck exits 0 for renderer and Electron configs.
- ESLint exits 0 with zero warnings.
- Vitest reports all tests passed.

- [ ] **Step 6: Run focused build and E2E gates**

Run:

```bash
npm run build
npm run probe:e2e
```

Expected: production renderer/main/mobile bundles build; all discovered harnesses and probes pass, including the three mobile harnesses.

- [ ] **Step 7: Verify boundaries, version, commit integration, and absence of forbidden behavior**

Run:

```bash
git grep -n "from ['\"]\\.\\./.*electron\\|from ['\"]electron" -- src
git grep -n "session\\.resize" -- src/mobile scripts/harness-e2e-mobile-terminal-sync.mjs scripts/harness-e2e-mobile-remote-visual.mjs
git grep -n "\\.focus()\\|\\.blur()\\|onData(" -- src/mobile
node -e "const p=require('./package.json'); if(p.version!=='0.2.20'||!/^>=22/.test(p.engines.node)) process.exit(1)"
if git log --format=%B -50 | grep -Fq "cherry picked from commit b730487cffd2784719a8ea7efcce9e209cfadc47"; then exit 1; fi
git log --format=%B -50 | grep -F "cherry picked from commit 61af85f11fcecc45b6c2a3aa68b825acefb9b59f"
git diff --check
```

Expected:

- no renderer import from `electron/`;
- no production phone `session.resize` send (legacy shared type/server compatibility branch may remain);
- no phone terminal focus/blur/onData registration;
- version is `0.2.20`, Node floor is at least 22;
- integration history has no `-x` cherry-pick of `b730487c`, while Send FIFO-barrier fix `61af85f1` is recorded with its `-x` source line;
- no whitespace errors.

- [ ] **Step 8: Self-review exact behavioral acceptance**

Use a real Claude session locally and confirm:

1. continuous desktop drag yields one visible redraw per 140 ms settled commit, not one per ResizeObserver event;
2. desktop remains useful-width while phone connects, rotates, opens/closes keyboard, zooms, reconnects, and switches sessions;
3. phone has exact current canonical geometry and no mixed-epoch artifacts;
4. horizontal pan reaches both edges;
5. vertical thumb drag and track jump work;
6. history distance from bottom survives output, barrier, reconnect, and switch;
7. selection/copy works and terminal/scrollbar actions do not focus helper textarea or move the composer.

- [ ] **Step 9: Run the final physical-phone public-relay gate with the integrated Send fix**

Precondition: exact Send fix commit `61af85f1` has been cherry-picked after the viewport work, its conflicts were resolved using Step 2's FIFO/identity/awaited-ack contract, and the focused combined tests pass.

On a physical phone connected through the public relay, run one combined session and verify:

1. Send submits once without an extra Enter.
2. Connecting/resizing the phone never shrinks the desktop terminal.
3. One desktop resize produces one barrier redraw.
4. Composer placement and keyboard focus remain stable.
5. Text is readable; pan, thumb drag, track jump, selection/copy, rotation, keyboard open/close, reconnect, and session switch all pass.

Record evidence in the PR description or issue tracker. Do not deploy, merge, tag, or release from this task.

- [ ] **Step 10: Commit documentation and acceptance notes**

```bash
git add README.md docs/README.md DEBT.md
git commit -m "docs(mobile): document independent terminal viewport" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

If `DEBT.md` was unchanged, omit it from `git add`. Before handoff, require `git status --short` to list no uncommitted implementation files and verify no task performed deployment, merge, tag, or release.
