import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { StrictMode } from 'react';
import { render, cleanup, act } from '@testing-library/react';

// IMPORTANT: mock the session runtime BEFORE importing MainPane so the mock
// instance is what the component talks to. The real runtime would try to open
// a browser WebSocket via WsClient, which jsdom does not implement.
//
// T10 reshape: ws lifecycle now lives in `session-runtime.ts` (a singleton),
// not inside MainPane. The contract MainPane must honour under StrictMode is:
//   - exactly ONE POST /api/sessions despite double-invoke (preserved from T6)
//   - exactly ONE runtime.attach(sid) per known sid despite double-invoke
//   - the OUTPUT listener registered on mount #1 still writes into the
//     terminal that mount #2 rebuilt (because it reads termRef + activeSidRef
//     at call time)

const runtimeAttach = vi.hoisted(() => vi.fn());
const runtimeDetach = vi.hoisted(() => vi.fn());
const runtimeHas = vi.hoisted(() => vi.fn(() => false));
const runtimeGet = vi.hoisted(() =>
  vi.fn(() => ({
    sid: '',
    client: null,
    status: 'idle' as const,
    scrollback: [] as Uint8Array[],
    scrollbackBytes: 0,
    lastSeq: 0,
    reconnectAttempts: 0,
    reconnectTimer: null,
    finalized: false,
  })),
);
const runtimeSendInput = vi.hoisted(() => vi.fn());
const runtimeSendResize = vi.hoisted(() => vi.fn());
const runtimeNotePendingWrite = vi.hoisted(() => vi.fn());
const runtimeNoteWriteFlushed = vi.hoisted(() => vi.fn());
const outputListenerHolder = vi.hoisted(() => ({
  current: null as ((sid: string, payload: Uint8Array | null) => void) | null,
}));
const runtimeSubscribeOutput = vi.hoisted(() =>
  vi.fn((cb: (sid: string, payload: Uint8Array | null) => void) => {
    outputListenerHolder.current = cb;
    return () => {
      if (outputListenerHolder.current === cb) outputListenerHolder.current = null;
    };
  }),
);

vi.mock('../src/runtime-context', () => ({
  useRuntime: () => ({
    attach: runtimeAttach,
    detach: runtimeDetach,
    has: runtimeHas,
    get: runtimeGet,
    sendInput: runtimeSendInput,
    sendResize: runtimeSendResize,
    notePendingWrite: runtimeNotePendingWrite,
    noteWriteFlushed: runtimeNoteWriteFlushed,
    subscribeOutput: runtimeSubscribeOutput,
  }),
  useApi: () => ({
    createSession: async (token: string) => {
      const res = await globalThis.fetch(
        `${typeof window !== 'undefined' ? window.location.origin : ''}/api/sessions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );
      return res.json();
    },
    deleteSession: async () => ({ ok: true }),
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async () => ({ ok: true }),
  }),
  useGetToken: () => () => 'test-token',
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
import { useStore } from '../src/store';

// Wait for the bootstrap promise chain (createSession + addSession) to flush.
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('MainPane under React.StrictMode (T10 reshape of P1-3 regression)', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    sessionStorage.setItem('ccsm.token', 'test-token');
    useStore.setState({
      token: 'test-token',
      sessions: [],
      activeSid: null,
      status: 'idle',
      sessionStatuses: {},
    });

    // jsdom shims for xterm. xterm queries matchMedia (color-scheme) and uses
    // a <canvas> via the DOM renderer. Neither is implemented in jsdom; stub
    // both so xterm.open() doesn't throw and tear down the React tree.
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

    fetchMock = vi.fn(async () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      ({
        ok: true,
        status: 200,
        json: async () => ({ sid: 'sid-test-1', createdAt: 0 }),
        text: async () => '',
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    runtimeAttach.mockClear();
    runtimeDetach.mockClear();
    runtimeHas.mockClear();
    runtimeHas.mockImplementation(() => false);
    runtimeGet.mockClear();
    runtimeGet.mockImplementation(() => ({
      sid: '',
      client: null,
      status: 'idle' as const,
      scrollback: [] as Uint8Array[],
      scrollbackBytes: 0,
      lastSeq: 0,
      reconnectAttempts: 0,
      reconnectTimer: null,
      finalized: false,
    }));
    runtimeSendInput.mockClear();
    runtimeSendResize.mockClear();
    runtimeSubscribeOutput.mockClear();
    outputListenerHolder.current = null;
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it('creates exactly one session despite StrictMode double-invoke', async () => {
    render(
      <StrictMode>
        <MainPane />
      </StrictMode>,
    );

    await flushMicrotasks();

    // Critical invariant carried over from T6: POST /api/sessions fires once
    // even though the bootstrap effect ran twice (mount → cleanup → re-mount
    // under StrictMode dev).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // T10 invariant: runtime.attach was invoked at least once for the
    // bootstrapped sid, but never with detach (detach belongs to the user-
    // initiated close path in the sidebar, not React cleanup).
    expect(runtimeAttach).toHaveBeenCalled();
    expect(runtimeAttach.mock.calls[0]![0]).toBe('sid-test-1');
    expect(runtimeDetach).not.toHaveBeenCalled();
  });

  it('mounts a live xterm into the container after the StrictMode remount', async () => {
    const { container } = render(
      <StrictMode>
        <MainPane />
      </StrictMode>,
    );

    await flushMicrotasks();

    // xterm 5.x renders the screen layer with class `.xterm-screen`. If the
    // ref guard wrongly skipped term creation on mount #2, this would be null.
    const screen = container.querySelector('.xterm-screen');
    expect(screen).not.toBeNull();

    const root = container.querySelector('.xterm');
    expect(root).not.toBeNull();

    const termHost = container.querySelector('[data-testid="main-terminal"]');
    expect(termHost).not.toBeNull();
    expect(termHost?.querySelector('.xterm')).not.toBeNull();
  });

  it('routes runtime OUTPUT for the active sid into the currently mounted terminal', async () => {
    render(
      <StrictMode>
        <MainPane />
      </StrictMode>,
    );

    await flushMicrotasks();

    // The MainPane subscribed an output listener on mount. The bootstrap
    // promoted the new sid to active, so writes for that sid should land in
    // the live terminal without throwing — even though mount #1's terminal
    // was disposed and only mount #2's terminal exists by this point.
    expect(runtimeSubscribeOutput).toHaveBeenCalled();
    expect(outputListenerHolder.current).not.toBeNull();
    const payload = new TextEncoder().encode('hello-from-pty');
    expect(() => outputListenerHolder.current!('sid-test-1', payload)).not.toThrow();
    // RESET path (payload === null) must also be safe.
    expect(() => outputListenerHolder.current!('sid-test-1', null)).not.toThrow();
    // A foreign sid is silently dropped.
    expect(() => outputListenerHolder.current!('other-sid', payload)).not.toThrow();
  });
});
