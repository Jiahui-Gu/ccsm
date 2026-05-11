// Task #716 — browser refresh must not POST a fresh /api/sessions.
//
// Two cases (both directly from the task acceptance criteria):
//   1. Refresh with EXISTING sessions on the daemon (listSessions returns
//      non-empty): bootstrap hydrates the store from listSessions, MainPane
//      renders, and createSession is NEVER called.
//   2. First-time visit with NO sessions on the daemon (listSessions returns
//      empty): bootstrap hydrates an empty list, MainPane renders the
//      "click + New Session" notice, and createSession is STILL NEVER called
//      (the user must click + New Session in the sidebar).
//
// We mock the runtime-context module so `useApi`, `useRuntime`,
// `useGetToken`, and `HttpError` are all predictable, and we render
// `<AppContent>`-shaped trees that combine `useBootstrap` + `<MainPane />`
// the same way the production shell does.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Hoisted mocks — declared before the dynamic import of MainPane / useBootstrap
// so the mock instance is what those modules pick up on first eval.
const createSessionMock = vi.hoisted(() => vi.fn(async () => ({ sid: 'never', createdAt: 0 })));
const listSessionsMock = vi.hoisted(() => vi.fn(async () => ({ sessions: [] as Array<{ sid: string; createdAt: number; alive: boolean }> })));
const deleteSessionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const resumeSessionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

const runtimeAttach = vi.hoisted(() => vi.fn());
const runtimeDetach = vi.hoisted(() => vi.fn());
const runtimeGet = vi.hoisted(() => vi.fn(() => undefined));
const runtimeSendInput = vi.hoisted(() => vi.fn());
const runtimeSendResize = vi.hoisted(() => vi.fn());
const runtimeNotePendingWrite = vi.hoisted(() => vi.fn());
const runtimeNoteWriteFlushed = vi.hoisted(() => vi.fn());
const runtimeSubscribeOutput = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock('../src/runtime-context', () => ({
  useRuntime: () => ({
    attach: runtimeAttach,
    detach: runtimeDetach,
    has: () => false,
    get: runtimeGet,
    sendInput: runtimeSendInput,
    sendResize: runtimeSendResize,
    notePendingWrite: runtimeNotePendingWrite,
    noteWriteFlushed: runtimeNoteWriteFlushed,
    subscribeOutput: runtimeSubscribeOutput,
  }),
  useApi: () => ({
    createSession: createSessionMock,
    deleteSession: deleteSessionMock,
    listSessions: listSessionsMock,
    resumeSession: resumeSessionMock,
  }),
  useGetToken: () => () => 'test-token',
  // R-57 (Task #181): useBootstrap + MainPane now consult useHostReady().
  // Tests in this file always run against a "daemon ready" scenario (they
  // exercise the listSessions hydration), so we stub a constant true.
  useHostReady: () => true,
  HttpError: class extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = 'HttpError';
    }
  },
}));

import { MainPane } from '../src/components/MainPane';
import { useBootstrap } from '../src/hooks/useBootstrap';
import { useStore } from '../src/store';

function AppShell() {
  useBootstrap();
  return <MainPane />;
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function installXtermShims(): void {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      measureText: () => ({ width: 8 }),
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      fillText: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
      arc: () => {},
      fill: () => {},
      canvas: { width: 0, height: 0 },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

describe('Task #716 — browser refresh must not auto-create a session', () => {
  beforeEach(() => {
    sessionStorage.setItem('ccsm.token', 'test-token');
    useStore.setState({
      token: 'test-token',
      sessions: [],
      activeSid: null,
      status: 'idle',
      sessionStatuses: {},
    });
    installXtermShims();

    createSessionMock.mockClear();
    listSessionsMock.mockClear();
    deleteSessionMock.mockClear();
    resumeSessionMock.mockClear();
    runtimeAttach.mockClear();
    runtimeDetach.mockClear();
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it('refresh with existing daemon sessions: hydrates list, never POSTs /api/sessions', async () => {
    // Simulate the daemon already having two live sessions when the user
    // hits F5 — useBootstrap.listSessions is the only path that should
    // populate the store.
    listSessionsMock.mockResolvedValueOnce({
      sessions: [
        { sid: 'sid-existing-1', createdAt: 1000, alive: true },
        { sid: 'sid-existing-2', createdAt: 2000, alive: true },
      ],
    });

    render(<AppShell />);
    await flushMicrotasks();

    // listSessions fired once (the bootstrap hook owns the GET).
    expect(listSessionsMock).toHaveBeenCalledTimes(1);
    // createSession MUST NOT fire — the bug was that MainPane's old
    // bootstrap effect raced this hydrate and POSTed a brand-new session
    // on every refresh.
    expect(createSessionMock).not.toHaveBeenCalled();
    // Store reflects the daemon's existing rows.
    expect(useStore.getState().sessions.map((s) => s.sid)).toEqual([
      'sid-existing-1',
      'sid-existing-2',
    ]);
    // Bootstrap deliberately leaves activeSid alone so the user picks.
    expect(useStore.getState().activeSid).toBeNull();
    // No runtime.attach: that's the user-action callers' job (Sidebar
    // onSelectSession after POST /resume).
    expect(runtimeAttach).not.toHaveBeenCalled();
  });

  it('first visit with empty daemon: still does NOT auto-create, waits for user to click + New Session', async () => {
    // The truly broken case before the #716 fix: a brand-new browser tab
    // opened against a daemon with no sessions auto-fired createSession,
    // teaching the app to multiply sessions on every refresh thereafter.
    listSessionsMock.mockResolvedValueOnce({ sessions: [] });

    render(<AppShell />);
    await flushMicrotasks();

    expect(listSessionsMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(useStore.getState().sessions).toEqual([]);
    expect(useStore.getState().activeSid).toBeNull();
    expect(runtimeAttach).not.toHaveBeenCalled();
  });
});
