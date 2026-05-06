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

// IMPORTANT: mock the WsClient before importing MainPane so the mock instance
// is what the component constructs. The real WsClient would try to open a
// browser WebSocket, which jsdom does not implement.
const wsConnect = vi.fn();
const wsSendResize = vi.fn();
const wsSendInput = vi.fn();
const wsClose = vi.fn();
const wsCtor = vi.fn();

vi.mock('../src/ws/client', () => {
  class FakeWsClient {
    onOutput?: (data: Uint8Array) => void;
    onExit?: (code: number) => void;
    onStatusChange?: (s: string) => void;
    onDisconnect?: (reason: string) => void;
    constructor(opts: Record<string, unknown>) {
      wsCtor(opts);
    }
    connect = wsConnect;
    sendResize = wsSendResize;
    sendInput = wsSendInput;
    close = wsClose;
  }
  return { WsClient: FakeWsClient };
});

import { MainPane } from '../src/components/MainPane';

// Wait for the bootstrap promise chain (createSession + setSid) to flush.
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('MainPane under React.StrictMode (P1-3 regression)', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    sessionStorage.setItem('ccsm.token', 'test-token');

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
    // Minimal CanvasRenderingContext2D stub — xterm only needs measureText to
    // return *something* with a width during initial layout in jsdom.
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

    // jsdom doesn't ship fetch in older targets; install a mock unconditionally
    // so we can count how many POST /api/sessions calls happen.
    fetchMock = vi.fn(async () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      ({
        ok: true,
        status: 200,
        json: async () => ({ sid: 'sid-test-1' }),
        text: async () => '',
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    wsConnect.mockClear();
    wsSendResize.mockClear();
    wsSendInput.mockClear();
    wsClose.mockClear();
    wsCtor.mockClear();
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

    // Critical invariant: POST /api/sessions fires once even though the effect
    // ran twice (mount → cleanup → re-mount under StrictMode dev).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wsCtor).toHaveBeenCalledTimes(1);
    expect(wsConnect).toHaveBeenCalledTimes(1);
    // NOTE: WsClient.close MUST NOT be called during StrictMode unmount,
    // otherwise the long-lived ws would be torn down immediately after
    // creation. Closing only happens on real component unmount.
    expect(wsClose).not.toHaveBeenCalled();
  });

  it('mounts a live xterm into the container after the StrictMode remount', async () => {
    const { container } = render(
      <StrictMode>
        <MainPane />
      </StrictMode>,
    );

    await flushMicrotasks();

    // xterm 5.x renders the screen layer with class `.xterm-screen`. If the
    // ref guard wrongly skipped term creation on mount #2, this would be null
    // (the previous Terminal was disposed in cleanup #1).
    const screen = container.querySelector('.xterm-screen');
    expect(screen).not.toBeNull();

    // The xterm root applies the `.xterm` class to the host div.
    const root = container.querySelector('.xterm');
    expect(root).not.toBeNull();

    // The data-testid wrapper must still be present and contain the xterm DOM.
    const termHost = container.querySelector('[data-testid="main-terminal"]');
    expect(termHost).not.toBeNull();
    expect(termHost?.querySelector('.xterm')).not.toBeNull();
  });

  it('routes ws output into the *currently mounted* terminal after remount', async () => {
    render(
      <StrictMode>
        <MainPane />
      </StrictMode>,
    );

    await flushMicrotasks();

    // Pull the WsClient construction args — the callbacks captured here are
    // the ones bound on mount #1. They must still be able to write into the
    // terminal that was rebuilt on mount #2 (because they go via termRef).
    expect(wsCtor).toHaveBeenCalledTimes(1);
    const opts = wsCtor.mock.calls[0]![0] as {
      onOutput: (data: Uint8Array) => void;
    };

    // Simulate an OUTPUT frame arriving after the StrictMode remount.
    const payload = new TextEncoder().encode('hello-from-pty');
    expect(() => opts.onOutput(payload)).not.toThrow();
  });
});
