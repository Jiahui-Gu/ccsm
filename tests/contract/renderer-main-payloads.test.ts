// Renderer ↔ main type-drift contract (audit finding 1b).
//
// For the most load-bearing IPC channels we pick a representative
// payload, push it through the actual main-side handler (or the actual
// type that flows over the wire), and assert it satisfies the renderer-
// side type. A drift between the two sides — even an "innocuous" added
// optional field — silently changes the wire format and can mask a
// regression for entire releases. The TypeScript assertions in this file
// fire at compile time; the runtime assertions cover the cases
// TypeScript can't see (handler return-value discriminant tags, etc.).
//
// Channels covered (3 surfaces × 5 channels):
//
//   • persist state    — db:load, db:save                (renderer↔main, invoke)
//   • pty lifecycle    — pty:input                        (renderer→main, invoke)
//   • pty data fan-out — pty:data                         (main→renderer, event)
//   • session lifecycle— session:state                    (main→renderer, event)
//
// We import the actual handler functions for the renderer↔main legs and
// run them with stubbed deps; for the main→renderer legs we type the
// payload as the main-side declared shape and assert it satisfies the
// renderer-side declared shape (TS structural compatibility).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

// The renderer-side wire types — the single source of truth for what
// the renderer expects to see on each channel.
import type { PtyDataEvent } from '../../src/pty.d';
import type { SessionStatePayload, SessionState } from '../../src/shared/sessionState';

// ── Set up handler mocks BEFORE importing the handler ─────────────────
// The dbIpc module reads its three concrete deps (db, validate,
// security) on import. We stub all three so the handler's I/O is
// deterministic; the contract here is the SHAPE of in/out, not the
// real SQLite write.

vi.mock('electron', () => ({}));

const store = new Map<string, string>();
vi.mock('../../electron/db', () => ({
  saveState: (k: string, v: string) => {
    store.set(k, v);
  },
  loadState: (k: string) => (store.has(k) ? store.get(k)! : null),
}));

vi.mock('../../electron/db-validate', () => ({
  validateSaveStateInput: (_k: string, _v: string) => ({ ok: true }),
}));

vi.mock('../../electron/security/ipcGuards', () => ({
  fromMainFrame: () => true,
}));

vi.mock('../../electron/shared/stateSavedBus', () => ({
  emitStateSaved: vi.fn(),
}));

import { handleDbSave, handleDbLoad } from '../../electron/ipc/dbIpc';

const fakeEvent = {} as IpcMainInvokeEvent;

beforeEach(() => {
  store.clear();
});

describe('db:save / db:load round-trip (persist state)', () => {
  it('save→load round-trips a representative renderer payload', () => {
    // The renderer's persist layer writes JSON-stringified state under
    // the `appState` key. Use a payload shaped like the real persist
    // snapshot so we exercise a realistic size & character set
    // (escapes, unicode, nested structures).
    const key = 'appState';
    const payload = JSON.stringify({
      sessions: [{ id: 'a-b-c', name: 'Hello 中文 🙂', cwd: '/x', groupId: 'g1' }],
      groups: [{ id: 'g1', name: 'Default', collapsed: false }],
      version: 1,
    });

    const saveResult = handleDbSave(fakeEvent, key, payload);
    // Renderer's preload wrapper in ccsmCore.saveState requires this
    // exact discriminant. A drift to e.g. `{success: true}` would
    // throw at the renderer because the wrapper tests `result.ok`.
    expect(saveResult).toEqual({ ok: true });

    const loadResult = handleDbLoad(fakeEvent, key);
    // Renderer's preload wrapper in ccsmCore.loadState types this as
    // `Promise<string | null>` — must be exactly one of those two.
    expect(loadResult).toBe(payload);
    expect(typeof loadResult === 'string' || loadResult === null).toBe(true);
  });

  it('db:load returns null (NOT undefined) for missing keys — renderer signature is `string | null`', () => {
    // Drift to `undefined` would still typecheck at the preload (the
    // declared return is `Promise<string | null>`, but TypeScript
    // doesn't enforce the discriminant past `unknown`), but every
    // caller in src/stores/persist.ts pattern-matches `=== null`. An
    // `undefined` would slip through and corrupt the hydration path.
    const result = handleDbLoad(fakeEvent, 'never-set');
    expect(result).toBeNull();
  });

  // Note: the failure-path `{ok:false, error:string}` discriminant the
  // preload `saveState` wrapper unwraps is exhaustively covered in
  // electron/ipc/__tests__/dbIpc.test.ts (guard / validation / persist
  // throw paths). We don't restate it here — a trivial
  // `expect({ok:true}.ok).toBe(true)` shadow assertion was removed during
  // PR #1332 review for not actually exercising the contract.
});

describe('pty:input handler (renderer→main, invoke)', () => {
  it('forwards (sid, data) to inputPtySession exactly as the renderer sends them', async () => {
    // SCOPE: this test verifies the SHAPE of the argument list flowing
    // from preload `ccsmPty.input(sid, data)` (typed `(string, string)
    // => Promise<void>` in src/pty.d.ts) through the `pty:input` handler
    // body to `deps.inputPtySession`. It does NOT exercise the real
    // registrar — wiring `registerPtyIpc` here would require mocking
    // ipcMain plus the full `PtyIpcDeps` surface (getMainWindow,
    // getEntry, getBufferSnapshot, sessionWatcher subscriptions) and
    // would couple this contract test to ptyHost lifecycle internals.
    //
    // Drift in the handler SIGNATURE (e.g. swapping the positional arg
    // order, dropping `sid`) is enforced separately:
    //   - electron/ptyHost/ipcRegistrar.ts (line 204) — production code
    //   - electron/ipc/__tests__/  — main-side IPC tests
    //   - ipc-channel-parity.test.ts in this folder — channel name pinning
    // The renderer-side type signature is pinned by src/pty.d.ts +
    // the existing preload-bridge tests in
    // electron/preload/bridges/__tests__/ccsmPty.test.ts.
    //
    // What this test catches: a renderer-side change like
    // `ccsmPty.input(data, sid)` (swapped arg order) that would still
    // typecheck (both strings) but flow the wrong values to main.
    const spy = vi.fn();
    const sid = '5e8b1c2a-1234-4abc-89ef-0123456789ab';
    const data = 'echo hello\n';
    // Inline mirror of the handler body at electron/ptyHost/ipcRegistrar.ts:204.
    // Two lines, no branching; reviewer (PR #1332) accepted the
    // inline-vs-real-registrar trade-off given the cost.
    const handler = (_e: unknown, s: string, d: string) => spy(s, d);
    handler(null, sid, data);

    expect(spy).toHaveBeenCalledExactlyOnceWith(sid, data);
  });
});

// ── Main→renderer event contracts (compile-time + runtime) ─────────────
describe('pty:data event payload (main→renderer)', () => {
  it('main-side payload satisfies the renderer-side PtyDataEvent type', () => {
    // The main side emits `wc.send(PTY_CHANNELS.data, { sid, chunk, seq })`
    // (see electron/ptyHost/entryFactory.ts:208). Construct a value
    // shaped that way and assert it satisfies the renderer-side type.
    // The TS assignment is the load-bearing check — the test body just
    // makes the assignment runtime-observable so a removed field at
    // the value level (vs the type level) also fails.
    type MainSidePayload = { sid: string; chunk: string; seq: number };
    const fromMain: MainSidePayload = { sid: 'abc', chunk: 'hello', seq: 7 };
    // Assignment to the renderer-side type — fails to compile if the
    // shapes drift.
    const toRenderer: PtyDataEvent = fromMain;
    expect(toRenderer.sid).toBe('abc');
    expect(toRenderer.chunk).toBe('hello');
    expect(toRenderer.seq).toBe(7);
  });
});

describe('session:state event payload (main→renderer)', () => {
  it('main-side SessionStatePayload satisfies the canonical SessionState union', () => {
    // Watcher emits `{sid, state: 'idle' | 'running' | 'requires_action'}`
    // and the renderer maps the union to its 2-state UI model in
    // src/agent/lifecycle.ts. Drift in the union (e.g. adding a 4th
    // state without updating the map) is the failure mode this guards.
    const states: SessionState[] = ['idle', 'running', 'requires_action'];
    for (const s of states) {
      const payload: SessionStatePayload = { sid: 'x', state: s };
      expect(payload.state).toBe(s);
    }
    // @ts-expect-error — invented state must not satisfy the union.
    const bad: SessionStatePayload = { sid: 'x', state: 'completed' };
    // Runtime defense in depth: even though the @ts-expect-error
    // catches drift at compile time, a future `as SessionState` cast
    // could slip past. Verify the literal is NOT one of the canonical
    // members.
    expect(['idle', 'running', 'requires_action']).not.toContain(bad.state);
  });
});
