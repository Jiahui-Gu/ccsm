# Mobile Composer and Incremental Terminal Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the phone remote with a touch-safe composer, faithful read-only xterm.js rendering, exactly-once incremental PTY synchronization, and release-blocking dogfood.

**Architecture:** The existing encrypted relay continues carrying authoritative PTY snapshots and sequenced live chunks. A pure synchronization reducer converts those messages into xterm effects, while React owns navigation, connection chrome, per-session drafts, the composer, and discrete control keys. The desktop validates complete-draft submissions and injects normalized bracketed paste plus Enter into the selected PTY.

**Tech Stack:** React 18, TypeScript, Zustand 5, xterm.js 5.5, Electron, node-pty, Vitest, Testing Library, Playwright, Cloudflare Workers relay.

## Global Constraints

- Run this plan on `jiahui-gu-mobile-remote-shared-ui` after completing Task 4 of `docs/superpowers/plans/2026-07-21-mobile-remote-shared-ui.md`.
- This plan supersedes Tasks 5 through 8 of `docs/superpowers/plans/2026-07-21-mobile-remote-shared-ui.md`.
- Preserve commits `f8b27ffc`, `3d225cc5`, `d4556703`, and `c3e0285d`; do not redo the navigation contracts, source, polling, or shared navigator.
- Use npm only and Node >= 22.
- Renderer code under `src/` must not import from `electron/`.
- Keep the project version at `0.2.20`; do not create a tag or release.
- Keep AES-GCM pairing, Cloudflare relay routing, PTY ownership, and desktop Zustand persistence intact.
- The terminal is read, scroll, select, and copy only. It never opens the software keyboard.
- The composer textarea is the only software-keyboard entry point. Application state never calls `focus()` or `blur()` on it.
- `AskUserQuestion` keeps Claude's native PTY UI. Selection uses discrete keys; free text uses the shared composer.
- Drafts and PTY input are never replayed after reconnect.
- Every task uses TDD and commits only its own files with the required co-author trailer.

## File Structure

### Shared protocol and submission

- `src/shared/mobileRemote/protocol.ts`: canonical client/server messages, including acknowledged complete-draft submission.
- `src/shared/terminal/preparePastePayload.ts`: browser-safe CR normalization and bracketed-paste framing reused by desktop and remote submission.
- `src/terminal/paste.ts`: imports the shared normalizer and retains clipboard/image orchestration.
- `electron/ptyHost/lifecycle.ts`: validates a live sid and atomically writes a complete prepared draft plus Enter.
- `electron/ptyHost/index.ts`: exports the submission seam.
- `electron/remote/remoteMessages.ts`: validates `session.submit` and returns a correlated result.

### Phone state and rendering

- `src/mobile/terminalSync.ts`: pure exactly-once snapshot/live synchronization state machine.
- `src/mobile/mobileRemoteStore.ts`: connection, navigation, per-session drafts, submission state, drawer state, and terminal effects.
- `src/mobile/mobileTerminalAdapter.ts`: owns one long-lived xterm instance, addons, viewport fitting, copy behavior, and test serialization.
- `src/mobile/components/MobileTerminal.tsx`: React lifecycle wrapper for the adapter.
- `src/mobile/components/MessageComposer.tsx`: controlled multiline textarea and explicit Send button.
- `src/mobile/components/TerminalKeyBar.tsx`: discrete PTY keys with no text streaming.
- `src/mobile/components/PhoneShell.tsx`: top bar, drawer, terminal, connection banner, controls, and store wiring.
- `src/mobile/components/SessionDrawer.tsx`: temporary accessible grouped navigation drawer.
- `src/mobile/index.tsx`: pairing bootstrap and React root.
- `src/mobile/mobile.css`: shared tokens, touch sizes, safe areas, drawer, terminal, composer, and visible viewport layout.

### Verification

- `scripts/fixtures/mobile-remote-pty-fixture.mjs`: deterministic ANSI and alternate-screen stream.
- `scripts/harness-e2e-mobile-remote-relay.mjs`: encrypted relay, composer, reconnect, and real-time flow.
- `scripts/harness-e2e-mobile-terminal-sync.mjs`: fault-injected buffer-parity dogfood.
- `scripts/harness-e2e-mobile-remote-visual.mjs`: portrait, landscape, and keyboard viewport geometry.
- `docs/reference/e2e-runner.md`: exact local, public relay, real CLI, and physical-phone procedures.

---

### Task 1: Acknowledged Complete-Draft Submission

**Files:**
- Create: `src/shared/terminal/preparePastePayload.ts`
- Create: `src/shared/terminal/__tests__/preparePastePayload.test.ts`
- Modify: `src/shared/mobileRemote/protocol.ts`
- Modify: `src/terminal/paste.ts`
- Modify: `electron/ptyHost/lifecycle.ts`
- Modify: `electron/ptyHost/index.ts`
- Modify: `electron/ptyHost/__tests__/lifecycle.test.ts`
- Modify: `electron/remote/remoteMessages.ts`
- Create: `electron/remote/__tests__/remoteMessages.test.ts`

**Interfaces:**
- Produces `preparePastePayload(text: string, bracketed: boolean): string`.
- Produces `submitPtySession(sid: string, draft: string): PtySubmitResult`.
- Adds client message `{ type: 'session.submit'; sid: string; requestId: string; draft: string }`.
- Adds server message `{ type: 'session.submit.result'; sid: string; requestId: string; ok: boolean; error?: 'invalid_submission' | 'session_not_found' | 'pty_write_failed' }`.
- Submission messages remain outside `RelayClient`'s recovery queue.

- [ ] **Step 1: Write failing shared-normalizer tests**

```ts
import { describe, expect, it } from 'vitest';
import { preparePastePayload } from '../preparePastePayload';

describe('preparePastePayload', () => {
  it('normalizes CRLF and lone CR without changing LF', () => {
    expect(preparePastePayload('a\r\nb\rc\n', false)).toBe('a\nb\nc\n');
  });

  it('wraps the complete normalized draft once in bracketed paste', () => {
    expect(preparePastePayload('你好\r\nworld', true)).toBe(
      '\x1b[200~你好\nworld\x1b[201~',
    );
  });
});
```

- [ ] **Step 2: Run the normalizer tests and confirm failure**

Run:

```powershell
npx vitest run src/shared/terminal/__tests__/preparePastePayload.test.ts
```

Expected: FAIL because `preparePastePayload.ts` does not exist.

- [ ] **Step 3: Extract the production normalizer**

```ts
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export function preparePastePayload(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return bracketed
    ? `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`
    : normalized;
}
```

Delete the duplicate implementation and constants from `src/terminal/paste.ts`;
import the shared helper there so desktop paste behavior remains identical.

- [ ] **Step 4: Write failing PTY submission tests**

Add lifecycle tests with a fake entry whose `headless.modes.bracketedPasteMode`
and `pty.write` are observable:

```ts
it('submits a complete bracketed multiline draft and Enter in one PTY write', () => {
  const { sessions, pty } = makeSession({ bracketedPasteMode: true });

  expect(submit(sessions, 's1', 'one\r\ntwo')).toBe('ok');
  expect(pty.write).toHaveBeenCalledOnce();
  expect(pty.write).toHaveBeenCalledWith('\x1b[200~one\ntwo\x1b[201~\r');
});

it('rejects empty drafts and missing sessions without writing', () => {
  const { sessions, pty } = makeSession({ bracketedPasteMode: false });
  expect(submit(sessions, 's1', '')).toBe('invalid_submission');
  expect(submit(sessions, 'missing', 'hello')).toBe('session_not_found');
  expect(pty.write).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Implement and export the PTY submission seam**

In `electron/ptyHost/lifecycle.ts`:

```ts
export type PtySubmitResult =
  | 'ok'
  | 'invalid_submission'
  | 'session_not_found'
  | 'pty_write_failed';

export function submit(
  sessions: Map<string, Entry>,
  sid: string,
  draft: string,
): PtySubmitResult {
  const entry = sessions.get(sid);
  if (draft.length === 0) return 'invalid_submission';
  if (!entry) return 'session_not_found';
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

In `electron/ptyHost/index.ts`:

```ts
export const submitPtySession = (sid: string, draft: string): boolean =>
  L.submit(sessions, sid, draft);
```

- [ ] **Step 6: Write failing protocol-handler tests**

```ts
it('acknowledges a complete draft only after the PTY accepts it', async () => {
  submitPtySession.mockReturnValue('ok');
  await handleClientMessage(peer, JSON.stringify({
    type: 'session.submit',
    sid: 's1',
    requestId: 'req-1',
    draft: '你好\nworld',
  }));
  expect(submitPtySession).toHaveBeenCalledWith('s1', '你好\nworld');
  expect(peer.send).toHaveBeenCalledWith({
    type: 'session.submit.result',
    sid: 's1',
    requestId: 'req-1',
    ok: true,
  });
});

it.each([
  [{ sid: '', requestId: 'r', draft: 'x' }, 'invalid_submission'],
  [{ sid: 's', requestId: '', draft: 'x' }, 'invalid_submission'],
  [{ sid: 's', requestId: 'r', draft: '' }, 'invalid_submission'],
])('rejects malformed submissions', async (payload, error) => {
  await handleClientMessage(peer, JSON.stringify({ type: 'session.submit', ...payload }));
  expect(peer.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'session.submit.result',
    ok: false,
    error,
  }));
});
```

- [ ] **Step 7: Add the wire messages and handler**

Use a 64 KiB character ceiling:

```ts
export const MAX_MOBILE_SUBMIT_CHARS = 65_536;

export type MobileClientMessage =
  | { type: 'sessions.list' }
  | { type: 'session.snapshot'; sid: string }
  | { type: 'session.input'; sid: string; data: string }
  | { type: 'session.submit'; sid: string; requestId: string; draft: string }
  | { type: 'session.resize'; sid: string; cols: number; rows: number };

export type SessionSubmitResult = {
  type: 'session.submit.result';
  sid: string;
  requestId: string;
  ok: boolean;
  error?: 'invalid_submission' | 'session_not_found' | 'pty_write_failed';
};
```

Validate all fields, reject drafts longer than `MAX_MOBILE_SUBMIT_CHARS`, call
`submitPtySession`, and map its explicit result to one correlated response. Do
not throw or send a success-shaped fallback.

- [ ] **Step 8: Run focused tests**

```powershell
npx vitest run src/shared/terminal/__tests__/preparePastePayload.test.ts electron/ptyHost/__tests__/lifecycle.test.ts electron/remote/__tests__/remoteMessages.test.ts tests/contract/paste-normalization.property.test.ts
```

Expected: PASS, including existing desktop paste contract coverage.

- [ ] **Step 9: Commit submission support**

```powershell
git add src/shared/terminal src/shared/mobileRemote/protocol.ts src/terminal/paste.ts electron/ptyHost electron/remote/remoteMessages.ts electron/remote/__tests__/remoteMessages.test.ts
git commit -m "feat(remote): submit composed mobile drafts" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Exactly-Once Terminal Synchronization Reducer

**Files:**
- Create: `src/mobile/terminalSync.ts`
- Create: `tests/mobile/terminalSync.test.ts`
- Modify: `src/mobile/phoneApp.ts`
- Modify: `tests/mobile/phoneApp.test.ts`

**Interfaces:**
- Produces `TerminalSyncState`, `TerminalSyncEffect`, `beginTerminalSync`, `applyTerminalSnapshot`, and `applyTerminalChunk`.
- `TerminalSyncEffect` is one of `{ type: 'reset'; data: string }`, `{ type: 'write'; data: string }`, or `{ type: 'requestSnapshot'; sid: string }`.
- A session keeps at most 256 buffered chunks while a snapshot is in flight.

- [ ] **Step 1: Write failing synchronization tests**

```ts
it('writes only the next sequence and drops duplicate or stale chunks', () => {
  const live = syncedState('s1', 8);
  expect(applyTerminalChunk(live, chunk(9, 'new')).effects).toEqual([
    { type: 'write', data: 'new' },
  ]);
  expect(applyTerminalChunk(live, chunk(8, 'duplicate')).effects).toEqual([]);
});

it('requests one snapshot on a gap and buffers the tail', () => {
  const first = applyTerminalChunk(syncedState('s1', 8), chunk(11, 'eleven'));
  expect(first.effects).toEqual([{ type: 'requestSnapshot', sid: 's1' }]);
  const second = applyTerminalChunk(first.state, chunk(12, 'twelve'));
  expect(second.effects).toEqual([]);
});

it('replaces once then drains only the contiguous post-snapshot tail', () => {
  let syncing = beginTerminalSync('s1');
  syncing = applyTerminalChunk(syncing, chunk(11, 'eleven')).state;
  syncing = applyTerminalChunk(syncing, chunk(10, 'ten')).state;
  const applied = applyTerminalSnapshot(syncing, snapshot(9, 'screen'));
  expect(applied.effects).toEqual([
    { type: 'reset', data: 'screen' },
    { type: 'write', data: 'ten' },
    { type: 'write', data: 'eleven' },
  ]);
  expect(applied.state.lastSeq).toBe(11);
  expect(applied.state.phase).toBe('live');
});

it('does not append a stale snapshot over a live screen', () => {
  const result = applyTerminalSnapshot(syncedState('s1', 12), snapshot(9, 'old'));
  expect(result.effects).toEqual([]);
});
```

- [ ] **Step 2: Run and confirm missing-module failure**

```powershell
npx vitest run tests/mobile/terminalSync.test.ts
```

Expected: FAIL because `terminalSync.ts` does not exist.

- [ ] **Step 3: Implement the pure synchronization state**

```ts
export const MAX_BUFFERED_TERMINAL_CHUNKS = 256;

export type TerminalSyncState = {
  sid: string | null;
  phase: 'idle' | 'syncing' | 'live';
  lastSeq: number;
  snapshotRequested: boolean;
  buffered: ReadonlyMap<number, string>;
};

export type TerminalSyncEffect =
  | { type: 'reset'; data: string }
  | { type: 'write'; data: string }
  | { type: 'requestSnapshot'; sid: string };

export type TerminalSyncResult = {
  state: TerminalSyncState;
  effects: TerminalSyncEffect[];
};
```

Implementation rules:

```ts
export function applyTerminalChunk(
  state: TerminalSyncState,
  message: { sid: string; seq: number; chunk: string },
): TerminalSyncResult {
  if (message.sid !== state.sid || message.seq <= state.lastSeq) {
    return { state, effects: [] };
  }
  if (state.phase === 'live' && message.seq === state.lastSeq + 1) {
    return {
      state: { ...state, lastSeq: message.seq },
      effects: [{ type: 'write', data: message.chunk }],
    };
  }
  const buffered = boundedInsert(state.buffered, message.seq, message.chunk);
  const request = !state.snapshotRequested && state.sid
    ? [{ type: 'requestSnapshot' as const, sid: state.sid }]
    : [];
  return {
    state: { ...state, phase: 'syncing', buffered, snapshotRequested: true },
    effects: request,
  };
}
```

`applyTerminalSnapshot` rejects a sid mismatch and a snapshot older than a live
state. In syncing state it emits one reset, drops buffered seq values at or
below the snapshot seq, drains contiguous values in ascending order, and stays
syncing with one new snapshot request when the remaining tail still starts
after a gap.

- [ ] **Step 4: Replace the permissive phone reducer fields**

Remove `snapshotSequence`, `terminalReset`, and `terminalWrites` from
`PhoneState`. Store `terminalSync` and expose reducer effects explicitly:

```ts
export type PhoneTransition = {
  state: PhoneState;
  terminalEffects: TerminalSyncEffect[];
  commands: MobileClientMessage[];
};
```

`selectSession` calls `beginTerminalSync(sid)` and queues one
`session.snapshot`. `applyServerMessage` delegates snapshot and PTY messages to
the new reducer. Do not let a gap write directly to xterm.

- [ ] **Step 5: Run focused reducer tests**

```powershell
npx vitest run tests/mobile/terminalSync.test.ts tests/mobile/phoneApp.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit synchronization state**

```powershell
git add src/mobile/terminalSync.ts src/mobile/phoneApp.ts tests/mobile/terminalSync.test.ts tests/mobile/phoneApp.test.ts
git commit -m "fix(remote): synchronize mobile terminal exactly once" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Phone Store, Per-Session Drafts, and Reconnect State

**Files:**
- Create: `src/mobile/mobileRemoteStore.ts`
- Create: `tests/mobile/mobileRemoteStore.test.ts`
- Modify: `src/mobile/relayClient.ts`
- Modify: `tests/mobile/relayClient.test.ts`

**Interfaces:**
- Produces `MobileRemoteViewState` and `createMobileRemoteStore(client)`.
- Produces store actions `setDraft`, `submitDraft`, `sendControl`, `selectSession`, `setDrawerOpen`, and `retry`.
- Extends `RelayClient` with `retry(): void`.
- Consumes `session.submit.result` and clears only the matching acknowledged draft.

- [ ] **Step 1: Write failing draft and reconnect tests**

```ts
it('keeps independent drafts while switching sessions', () => {
  const store = createTestStore();
  store.getState().selectSession('s1');
  store.getState().setDraft('first');
  store.getState().selectSession('s2');
  store.getState().setDraft('second');
  expect(store.getState().drafts).toEqual({ s1: 'first', s2: 'second' });
});

it('clears only the draft acknowledged by the desktop', async () => {
  const { store, client } = createTestStore();
  store.getState().selectSession('s1');
  store.getState().setDraft('hello');
  await store.getState().submitDraft();
  const request = client.sent.at(-1);
  store.getState().receive({
    type: 'session.submit.result',
    sid: 's1',
    requestId: request.requestId,
    ok: true,
  });
  expect(store.getState().drafts.s1).toBe('');
});

it('preserves a rejected draft and never queues it for reconnect', async () => {
  const { store, client } = createTestStore({ sendError: new Error('connection_changed') });
  store.getState().selectSession('s1');
  store.getState().setDraft('keep me');
  await store.getState().submitDraft();
  expect(store.getState().drafts.s1).toBe('keep me');
  expect(store.getState().submissionError).toBe('connection_changed');
  expect(client.recoveryQueue).not.toContainEqual(expect.objectContaining({
    type: 'session.submit',
  }));
});
```

- [ ] **Step 2: Run store tests and confirm failure**

```powershell
npx vitest run tests/mobile/mobileRemoteStore.test.ts tests/mobile/relayClient.test.ts
```

Expected: FAIL because the store and retry method do not exist.

- [ ] **Step 3: Implement the store state**

```ts
export type MobileRemoteViewState = {
  navigator: SessionNavigatorModel;
  selectedSessionId: string | null;
  exitedSessionId: string | null;
  connection: PhoneConnectionStatus;
  inputEnabled: boolean;
  retryMode: 'automatic' | 'manual' | 'blocked';
  drawerOpen: boolean;
  drafts: Record<string, string>;
  // Keyed by sid — never a single global slot. Two sessions can each have
  // their own unacknowledged submission at once; PhoneShell derives its
  // Send-disabled state from only the selected sid's own entry.
  pendingSubmissions: Record<string, { requestId: string; draft: string }>;
  // Also keyed by sid — never a single global slot. A rejected/failed
  // submission for one session must never be visible on a different,
  // unrelated session's composer, and must still be there if the user
  // navigates back to the session that actually failed. PhoneShell derives
  // its visible alert from only the selected sid's own entry.
  submissionErrors: Record<string, string>;
  terminalSync: TerminalSyncState;
  terminalBatch: TerminalRenderBatch | null;
};
```

Submission behavior:

```ts
async function submitDraft(): Promise<void> {
  const state = get();
  const sid = state.selectedSessionId;
  const draft = sid ? state.drafts[sid] ?? '' : '';
  if (!sid || !state.inputEnabled || !draft || state.pendingSubmissions[sid]) return;
  const requestId = crypto.randomUUID();
  set((s) => {
    const { [sid]: _clearedError, ...remainingErrors } = s.submissionErrors;
    return {
      pendingSubmissions: { ...s.pendingSubmissions, [sid]: { requestId, draft } },
      submissionErrors: remainingErrors,
    };
  });
  try {
    await client.send({ type: 'session.submit', sid, requestId, draft });
  } catch (error) {
    set((s) => {
      const { [sid]: _removed, ...remaining } = s.pendingSubmissions;
      return {
        pendingSubmissions: remaining,
        submissionErrors: { ...s.submissionErrors, [sid]: normalizeSubmitError(error) },
      };
    });
  }
}
```

An `ok: true` result clears the draft only when sid, requestId, and the current
draft all match that sid's own pending submission, and clears only that sid's
own entry in `submissionErrors`. A negative result keeps the draft and sets
that sid's own visible error — never a different sid's. Editing or
resubmitting a sid clears only that sid's own prior error. Connection loss
clears every sid's entry in `pendingSubmissions` and keeps every draft; it
never touches `submissionErrors`, so a session's own visible error survives a
reconnect exactly as it did before. Navigator replacement retains a live
selected session or chooses the first live session in model order.

Every terminal reducer result is consumed once: store only `reset` and `write`
effects in a monotonically numbered render batch, and immediately send
`requestSnapshot` effects through the relay. The UI acknowledges a rendered
batch through `consumeTerminalBatch(id)` so an unrelated React render cannot
apply it twice.

```ts
export type TerminalRenderBatch = {
  id: number;
  effects: Array<Extract<TerminalSyncEffect, { type: 'reset' | 'write' }>>;
};
```

- [ ] **Step 4: Preserve relay recovery safety and add manual retry**

`session.submit` and `session.input` remain unsafe messages. Reject them on
connection generation change. Keep only `sessions.list`, `session.snapshot`,
and `session.resize` in the bounded deduplicated recovery queue.

```ts
export type RelayClient = {
  connect(): void;
  retry(): void;
  send(message: MobileClientMessage): Promise<void>;
  close(): void;
  onMessage(handler: (message: MobileServerMessage) => void): () => void;
  onStatus(handler: (status: PhoneConnectionStatus) => void): () => void;
};
```

`retry()` cancels the current reconnect timer, resets backoff to 500 ms, and
opens a new connection only for retryable transport failures. Authentication
and protocol failures remain blocked until re-pair or update.

- [ ] **Step 5: Run focused store, relay, and crypto tests**

```powershell
npx vitest run tests/mobile/mobileRemoteStore.test.ts tests/mobile/relayClient.test.ts tests/mobile/mobileRemoteCrypto.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit phone state**

```powershell
git add src/mobile/mobileRemoteStore.ts src/mobile/relayClient.ts tests/mobile/mobileRemoteStore.test.ts tests/mobile/relayClient.test.ts
git commit -m "feat(mobile): manage drafts and reconnect state" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Long-Lived Read-Only xterm Adapter

**Files:**
- Create: `src/mobile/mobileTerminalAdapter.ts`
- Create: `tests/mobile/mobileTerminalAdapter.test.ts`
- Create: `src/mobile/components/MobileTerminal.tsx`
- Create: `tests/mobile/MobileTerminal.test.tsx`

**Interfaces:**
- Produces `createMobileTerminalAdapter(element, options): MobileTerminalAdapter`.
- `MobileTerminalAdapter` exposes `apply`, `fit`, `copySelection`, `serialize`, and `dispose`.
- Consumes numbered `TerminalRenderBatch` values and emits deduplicated `session.resize`.

- [ ] **Step 1: Write failing adapter tests with injected terminal factories**

```ts
it('applies writes incrementally and snapshots as reset plus write', () => {
  const { adapter, terminal } = createHarness();
  adapter.apply([{ type: 'write', data: 'tail' }]);
  expect(terminal.reset).not.toHaveBeenCalled();
  expect(terminal.write).toHaveBeenCalledWith('tail');

  adapter.apply([{ type: 'reset', data: 'screen' }]);
  expect(terminal.reset).toHaveBeenCalledOnce();
  expect(terminal.write).toHaveBeenLastCalledWith('screen');
});

it('never focuses the xterm textarea on pointer interaction', () => {
  const { adapter, terminal } = createHarness();
  terminal.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  expect(terminal.focus).not.toHaveBeenCalled();
  adapter.dispose();
});

it('deduplicates resize emissions', () => {
  const onResize = vi.fn();
  const { adapter, fit } = createHarness({ onResize });
  fit.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
  adapter.fit();
  adapter.fit();
  expect(onResize).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run and confirm missing-adapter failure**

```powershell
npx vitest run tests/mobile/mobileTerminalAdapter.test.ts tests/mobile/MobileTerminal.test.tsx
```

Expected: FAIL because the adapter and component do not exist.

- [ ] **Step 3: Implement one stable xterm instance**

Create the terminal with:

```ts
const terminal = new Terminal({
  convertEol: false,
  disableStdin: true,
  cursorBlink: false,
  fontSize: 13,
  fontFamily: 'JetBrains Mono Variable, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  scrollback: 5000,
  theme: {
    background: '#0d0f12',
    foreground: '#e8eaed',
  },
});
```

Load `FitAddon`, `SerializeAddon`, `Unicode11Addon`, and `WebLinksAddon`.
Activate Unicode 11. Do not register `terminal.onData`. Prevent the helper
textarea from retaining focus after `open()` and after pointer interaction,
without cancelling pointer events used for selection.

Map effects:

```ts
function apply(effects: readonly TerminalSyncEffect[]): void {
  for (const effect of effects) {
    if (effect.type === 'reset') {
      terminal.reset();
      terminal.write(effect.data);
    } else if (effect.type === 'write') {
      terminal.write(effect.data);
    }
  }
}
```

`copySelection()` uses `terminal.getSelection()` and
`navigator.clipboard.writeText`, then clears selection only after success.
`serialize()` delegates to `SerializeAddon.serialize()`.

- [ ] **Step 4: Implement viewport fitting and cleanup**

Keep the existing 120 ms resize debounce and 250 ms orientation follow-up.
Listen to window resize/orientation and `visualViewport` resize/scroll. Set
`--app-height` from `visualViewport.height`. Suppress duplicate dimensions and
dispose every listener, timer, addon, and terminal exactly once.

- [ ] **Step 5: Implement the React wrapper without remounting**

```tsx
export function MobileTerminal({
  batch,
  onResize,
  onConsumed,
  adapterRef,
}: MobileTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastAppliedBatch = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const adapter = createMobileTerminalAdapter(hostRef.current, { onResize });
    adapterRef.current = adapter;
    return () => {
      adapterRef.current = null;
      adapter.dispose();
    };
  }, [adapterRef, onResize]);

  useLayoutEffect(() => {
    if (!batch || batch.id <= lastAppliedBatch.current || !adapterRef.current) return;
    adapterRef.current.apply(batch.effects);
    lastAppliedBatch.current = batch.id;
    onConsumed(batch.id);
  }, [adapterRef, batch, onConsumed]);

  return <div ref={hostRef} className="mobile-terminal" aria-label="Terminal output" />;
}
```

Ensure `onResize` is stable in `PhoneShell`; changing application state must
not recreate the adapter.

- [ ] **Step 6: Run adapter and component tests**

```powershell
npx vitest run tests/mobile/mobileTerminalAdapter.test.ts tests/mobile/MobileTerminal.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the terminal adapter**

```powershell
git add src/mobile/mobileTerminalAdapter.ts src/mobile/components/MobileTerminal.tsx tests/mobile/mobileTerminalAdapter.test.ts tests/mobile/MobileTerminal.test.tsx
git commit -m "feat(mobile): render PTY through read-only xterm" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: React Phone Shell, Composer, Drawer, and Control Keys

**Files:**
- Create: `src/mobile/components/MessageComposer.tsx`
- Create: `src/mobile/components/TerminalKeyBar.tsx`
- Create: `src/mobile/components/SessionDrawer.tsx`
- Create: `src/mobile/components/PhoneShell.tsx`
- Create: `tests/mobile/MessageComposer.test.tsx`
- Create: `tests/mobile/TerminalKeyBar.test.tsx`
- Create: `tests/mobile/SessionDrawer.test.tsx`
- Create: `tests/mobile/PhoneShell.test.tsx`
- Create: `src/mobile/index.tsx`
- Delete: `src/mobile/index.ts`
- Delete: `src/mobile/phonePage.ts`
- Modify: `src/mobile/mobile.css`
- Modify: `src/phone.html`
- Modify: `webpack.mobile.config.js`

**Interfaces:**
- Consumes `createMobileRemoteStore`, `SessionNavigator`, and `MobileTerminal`.
- Produces a touch-first phone UI with no terminal-driven keyboard focus.
- `MessageComposer` receives `draft`, `enabled`, `submitting`, `error`, `onDraftChange`, and `onSubmit`.
- `TerminalKeyBar` emits only predefined PTY strings.

- [ ] **Step 1: Write failing composer tests**

```tsx
it('keeps Return as a local newline and submits only from Send', async () => {
  const user = userEvent.setup();
  render(<ComposerHarness />);
  const input = screen.getByRole('textbox', { name: 'Message' });
  await user.type(input, 'first{enter}第二行');
  expect(input).toHaveValue('first\n第二行');
  expect(onSubmit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSubmit).toHaveBeenCalledOnce();
});

it('preserves the visible draft and disables Send while disconnected', () => {
  render(<MessageComposer draft="keep me" enabled={false} submitting={false} />);
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('keep me');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
});
```

- [ ] **Step 2: Write failing key-bar and shell tests**

```tsx
it('emits all discrete Claude TUI controls without focusing the composer', async () => {
  const user = userEvent.setup();
  render(<TerminalKeyBar enabled onInput={onInput} />);
  const expected = new Map([
    ['Esc', '\x1b'], ['Tab', '\t'], ['Up', '\x1b[A'], ['Down', '\x1b[B'],
    ['Left', '\x1b[D'], ['Right', '\x1b[C'], ['Space', ' '],
    ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'],
    ['Interrupt', '\x03'], ['Enter', '\r'],
  ]);
  for (const [name, data] of expected) {
    await user.click(screen.getByRole('button', { name }));
    expect(onInput).toHaveBeenLastCalledWith(data);
  }
});

it('does not focus or blur the composer for output, Ask, permission, or reconnect state', () => {
  render(<PhoneShell client={client} />);
  const composer = screen.getByRole('textbox', { name: 'Message' });
  const focus = vi.spyOn(composer, 'focus');
  const blur = vi.spyOn(composer, 'blur');
  emitPty('AskUserQuestion: choose an option');
  emitConnection('reconnecting');
  expect(focus).not.toHaveBeenCalled();
  expect(blur).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run component tests and confirm failure**

```powershell
npx vitest run tests/mobile/MessageComposer.test.tsx tests/mobile/TerminalKeyBar.test.tsx tests/mobile/SessionDrawer.test.tsx tests/mobile/PhoneShell.test.tsx
```

Expected: FAIL because the React controls do not exist.

- [ ] **Step 4: Implement the composer and fixed control map**

Use a normal controlled `<textarea>` with no Enter key interception. The Send
button calls `onSubmit`; it is disabled for an empty draft, disconnected state,
or pending submission. Render submission errors with `role="alert"`.

```ts
export const TERMINAL_KEYS = [
  { label: 'Esc', ariaLabel: 'Esc', data: '\x1b' },
  { label: 'Tab', ariaLabel: 'Tab', data: '\t' },
  { label: '↑', ariaLabel: 'Up', data: '\x1b[A' },
  { label: '↓', ariaLabel: 'Down', data: '\x1b[B' },
  { label: '←', ariaLabel: 'Left', data: '\x1b[D' },
  { label: '→', ariaLabel: 'Right', data: '\x1b[C' },
  { label: 'Space', ariaLabel: 'Space', data: ' ' },
  ...['1', '2', '3', '4'].map((data) => ({ label: data, ariaLabel: data, data })),
  { label: '^C', ariaLabel: 'Interrupt', data: '\x03' },
  { label: 'Enter', ariaLabel: 'Enter', data: '\r' },
] as const;
```

Key clicks call `client.send({ type: 'session.input', sid, data })` only while
connected. They do not focus either xterm or the composer.

- [ ] **Step 5: Implement the temporary accessible drawer and shell**

Use the existing shared `SessionNavigator`. The drawer:

- is temporary at every v0.3.0 breakpoint;
- traps Tab and Shift+Tab while open;
- closes on Escape, backdrop pointer action, and session selection;
- restores focus to the menu button after close;
- locks document scrolling while open.

Shell order:

```tsx
<div className="phone-shell">
  <PhoneTopBar />
  <ConnectionBanner />
  <SessionDrawer />
  <MobileTerminal />
  <div className="phone-controls">
    <TerminalKeyBar />
    <MessageComposer />
  </div>
</div>
```

Keep the last terminal visible beneath a non-modal reconnect banner. Disable
Send and control keys while disconnected. Keep per-session drafts in the store.

- [ ] **Step 6: Implement mobile layout and touch CSS**

```css
.phone-shell {
  height: var(--app-height, 100dvh);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--ccsm-app);
}

.phone-controls {
  padding-bottom: env(safe-area-inset-bottom);
  background: var(--ccsm-sidebar);
  border-top: 1px solid var(--ccsm-border);
}

.terminal-keybar {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.terminal-key,
.phone-menu-button,
.session-navigator-item--touch,
.composer-send {
  min-width: 44px;
  min-height: 44px;
}

.message-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.message-composer textarea {
  max-height: 32dvh;
  resize: none;
}
```

When `visualViewport` shrinks, the terminal refits into the remaining grid row;
controls stay above the keyboard. Terminal selection remains enabled.

- [ ] **Step 7: Switch bootstrap and webpack to TSX**

Render with `createRoot`. Preserve pairing import, same-tab re-pair reload,
service worker registration, CSP, manifest, and error fallback. Update webpack:

```js
entry: { phone: './src/mobile/index.tsx', sw: './src/mobile/sw.ts' },
resolve: { extensions: ['.tsx', '.ts', '.js'] },
```

Make mobile cache hashing recursively include nested component files in sorted
relative-path order.

- [ ] **Step 8: Run component and mobile build tests**

```powershell
npx vitest run tests/mobile
npm run build:mobile
```

Expected: PASS; `dist/mobile` contains HTML, manifest, service worker, CSS, and
the React phone bundle.

- [ ] **Step 9: Commit the React phone UX**

```powershell
git add src/mobile src/phone.html webpack.mobile.config.js tests/mobile
git commit -m "feat(mobile): add touch-safe remote composer" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Deterministic Buffer-Parity and Fault-Injection Dogfood

**Files:**
- Create: `scripts/fixtures/mobile-remote-pty-fixture.mjs`
- Create: `scripts/harness-e2e-mobile-terminal-sync.mjs`
- Create: `scripts/harness-e2e-mobile-remote-visual.mjs`
- Modify: `scripts/harness-e2e-mobile-remote-relay.mjs`
- Modify: `scripts/run-all-e2e.mjs`
- Modify: `docs/reference/e2e-runner.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces deterministic ANSI chunks with explicit sequence numbers.
- Compares browser `SerializeAddon.serialize()` with an authoritative `@xterm/headless` buffer at matching dimensions.
- Injects duplicates, stale frames, gaps, snapshot/live overlap, disconnect, and reconnect.

- [ ] **Step 1: Create the deterministic ANSI fixture**

```js
export const MOBILE_TERMINAL_FIXTURE = [
  'fixture-start\r\n',
  ...Array.from({ length: 120 }, (_, index) =>
    `line-${String(index + 1).padStart(3, '0')} ${'x'.repeat(96)}\r\n`),
  'progress 0%',
  '\r\x1b[2Kprogress 50%',
  '\r\x1b[2Kprogress 100%\r\n',
  '\x1b[2J\x1b[Hafter-clear\r\n',
  '\x1b[?1049halternate-screen\r\n\x1b[?1049l',
  'fixture-end\r\n',
];

export function sequencedFixture(startSeq = 1) {
  return MOBILE_TERMINAL_FIXTURE.map((chunk, index) => ({
    seq: startSeq + index,
    chunk,
  }));
}
```

- [ ] **Step 2: Add a test-only serialization seam**

When the page URL contains `ccsmTest=1`, expose:

```ts
window.__ccsmMobileTest = {
  serializeTerminal: () => terminalAdapterRef.current?.serialize() ?? '',
  getSyncState: () => store.getState().terminalSync,
};
```

Declare the global in `src/mobile/testBridge.d.ts`. Do not expose pairing
secrets, encryption keys, drafts, or relay frames.

- [ ] **Step 3: Build the buffer-parity harness**

The harness:

1. starts local Wrangler on a reserved port;
2. creates an encrypted simulated desktop;
3. feeds the same fixture chunks into an `@xterm/headless` terminal and the
   encrypted phone stream;
4. loads the phone at `?ccsmTest=1#pair=...`;
5. waits for the browser's last seq;
6. compares exact serialized buffers.

Use:

```js
const expected = authoritativeSerialize.serialize();
const actual = await phone.evaluate(() => window.__ccsmMobileTest.serializeTerminal());
assert.equal(actual, expected, 'phone buffer must equal authoritative headless buffer');
```

- [ ] **Step 4: Inject every synchronization fault**

Run independent cases:

```js
await caseDuplicateAndStale();       // seq N twice, then N-1
await caseSnapshotLiveOverlap();     // N+2 arrives while snapshot through N is in flight
await caseGapRecovery();             // omit N+1, send N+2, answer one snapshot request
await caseDisconnectDuringBurst();   // close relay midway, reconnect, snapshot, drain tail
await caseSessionSwitchRace();       // old sid tail arrives after selecting new sid
```

For each case assert:

- exact final buffer parity;
- each unique fixture marker appears exactly once;
- stale marker text is absent;
- snapshot request count is exactly one per detected gap;
- sync phase returns to `live`;
- no browser console errors.

- [ ] **Step 5: Update relay E2E for the composer and Ask free text**

Replace hidden xterm textarea typing with:

```js
const composer = phone.getByRole('textbox', { name: 'Message' });
await composer.fill('/status');
await phone.getByRole('button', { name: 'Send' }).click();
await waitFor('acknowledged /status submission', () =>
  desktop.submissions.includes('/status'));
```

Also verify:

- CJK composition is sent once as a complete draft;
- Return creates multiline local text;
- a rejected send preserves the draft and shows an alert;
- option `2`, Enter, free-text draft, and Send traverse a simulated
  `AskUserQuestion`;
- terminal pointer interaction leaves the composer unfocused;
- disconnect disables Send and keys while preserving the draft;
- reconnect never auto-submits the draft.

- [ ] **Step 6: Add viewport and visual proof**

Capture:

```text
artifacts/mobile-remote/portrait.png       390x844
artifacts/mobile-remote/keyboard-open.png  390x520
artifacts/mobile-remote/landscape.png      844x390
artifacts/mobile-remote/drawer.png         390x844
```

Before each screenshot assert the terminal, key bar, composer, Send button, and
open drawer are within the visible viewport and no target is smaller than 44
CSS pixels.

- [ ] **Step 7: Run deterministic dogfood**

```powershell
npm run build
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-relay.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs
```

Expected:

```text
[mobile-terminal-sync] PASS exact buffer parity across 5 fault cases
[mobile-remote-relay] PASS composer, controls, Ask, recovery, re-pair
[mobile-remote-visual] PASS portrait, keyboard, landscape, drawer
```

- [ ] **Step 8: Commit deterministic dogfood**

```powershell
git add scripts/fixtures/mobile-remote-pty-fixture.mjs scripts/harness-e2e-mobile-terminal-sync.mjs scripts/harness-e2e-mobile-remote-relay.mjs scripts/harness-e2e-mobile-remote-visual.mjs scripts/run-all-e2e.mjs docs/reference/e2e-runner.md .gitignore src/mobile/testBridge.d.ts
git commit -m "test(mobile): prove terminal buffer parity" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Real Claude, Public Relay, Physical Phone, and Final Gates

**Files:**
- Modify only files required by a reproduced failure or an important review finding.
- Do not modify package version, create tags, or create release metadata.

**Interfaces:**
- Produces a review-ready PR with automated gates and recorded dogfood evidence.
- Leaves v0.3.0 blocked until every item below passes.

- [ ] **Step 1: Run static, unit, integration, build, and Cloudflare gates**

```powershell
npm run typecheck
npm run lint
npm test
npm run test:cloudflare
npm run build
npm run cloudflare:dry-run
```

Expected: every command exits 0.

- [ ] **Step 2: Run the full automated E2E suite**

```powershell
npm run probe:e2e
```

Expected: all existing harnesses plus terminal sync, relay, and visual harnesses
pass.

- [ ] **Step 3: Run deterministic dogfood against the public relay**

```powershell
if (-not $env:CCSM_RELAY_URL) { throw 'CCSM_RELAY_URL must point to the deployed public relay' }
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-relay.mjs
```

Expected: the same PASS lines as local Wrangler. Do not deploy or rotate
production credentials unless the existing documented deployment procedure
requires it and the user has authorized that action.

- [ ] **Step 4: Run a real Claude CLI session through the phone**

Use the existing real-CLI probe utilities and the configured public relay.
Record pass/fail for:

1. `/status` submitted from the composer;
2. a prompt requesting a response long enough to scroll several screens;
3. a permission confirmation selected with discrete keys;
4. an `AskUserQuestion` option selected with arrows or digits and Enter;
5. an `AskUserQuestion` free-text response sent through the composer;
6. Ctrl+C from the key bar;
7. reconnect during active output followed by exact authoritative recovery.

After the long response and reconnect, compare the phone serialized buffer with
the desktop authoritative headless buffer. Any mismatch or duplicate marker is
a failure.

- [ ] **Step 5: Run physical-phone acceptance**

On a real phone over the public internet:

1. open CCSM and scan the QR code;
2. open and close the grouped drawer, then switch sessions;
3. long-press terminal text, select it, and copy it without opening the keyboard;
4. tap terminal whitespace and confirm the keyboard remains closed;
5. tap the composer and confirm the keyboard opens;
6. enter CJK text with IME, multiline text, and pasted text;
7. dismiss the keyboard and confirm terminal, key bar, and composer remain usable;
8. rotate portrait to landscape and back;
9. answer native permission and Ask flows;
10. disconnect the desktop or network with an unsent draft, reconnect, and
    confirm the draft remains unsent and output contains no repeated history;
11. re-pair in the existing browser tab.

Capture screenshots or a short screen recording for keyboard-open, selection,
Ask free text, and reconnect recovery.

- [ ] **Step 6: Request code review**

Invoke `requesting-code-review`. Ask the reviewer to inspect:

- submission validation, acknowledgements, and non-replay behavior;
- bracketed paste and desktop paste regression risk;
- exactly-once seq reducer, bounded buffering, gap recovery, and snapshot races;
- xterm lifetime, disposal, selection, copy, and focus suppression;
- React store subscriptions and per-session draft correctness;
- drawer focus trap, 44px targets, safe areas, and keyboard viewport behavior;
- deterministic dogfood coverage against every approved acceptance item.

- [ ] **Step 7: Fix important findings with focused tests**

For every high-confidence correctness, security, reliability, or accessibility
finding:

1. add the smallest failing test;
2. run it and confirm failure;
3. implement the focused fix;
4. rerun the focused test;
5. rerun the affected gate;
6. commit with the required co-author trailer.

- [ ] **Step 8: Re-run final verification**

```powershell
npm run typecheck
npm run lint
npm test
npm run test:cloudflare
npm run build
npm run cloudflare:dry-run
npm run probe:e2e
node scripts/harness-e2e-mobile-terminal-sync.mjs
```

Expected: every command exits 0 after review fixes.

- [ ] **Step 9: Confirm release invariants**

```powershell
git diff main...HEAD -- package.json package-lock.json cloudflare/src/relayRoom.ts src/shared/mobileRemote/crypto.ts
git grep -nE "from ['\"].*(electron|stores/store)" -- src/shared/sessionNavigator src/mobile
git status --short
```

Expected:

- package version remains `0.2.20`;
- no pairing crypto or relay routing change escaped focused review;
- renderer/shared code has no Electron or desktop-store imports;
- only intended source, tests, docs, and plan changes are tracked.

- [ ] **Step 10: Push and create the UX PR**

```powershell
git push -u origin HEAD
```

Create a PR titled:

```text
feat(mobile): deliver touch-first remote UX
```

The body must include architecture, composer behavior, Ask free-text path,
exactly-once terminal synchronization, automated commands and outcomes, public
relay results, physical-phone evidence, and the statement that version remains
`0.2.20` with no tag or release.

- [ ] **Step 11: Wait for required checks**

All required GitHub checks must pass. Investigate failures with
`systematic-debugging`; never rerun blindly. Merge only after checks are green
and the physical-phone acceptance evidence has been reviewed.
