// Focused behavior contract for `phonePage.ts`'s read-only terminal wiring
// (mobile composer/terminal-sync plan, Task 4 stale-behavior removal). This
// file is superseded by `MobileTerminal` in a later task, but until then it
// must not reintroduce a software-keyboard entry point on the terminal:
// no `terminal.onData`, no `terminal.focus()`/`blur()`, and no dead
// ctrl-sticky input-transform path.
//
// Shims mirror tests/terminal/reloadInputContract.test.ts — the only other
// place a real (non-mocked) xterm `Terminal` is exercised under jsdom.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

import { createPhonePage } from '../../src/mobile/phonePage';
import type { MobileClientMessage, MobileServerMessage } from '../../src/mobile/phoneApp';
import type { PhoneConnectionStatus, RelayClient } from '../../src/mobile/relayClient';

beforeAll(() => {
  const w = window as unknown as Record<string, unknown>;
  if (!w.matchMedia) {
    w.matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16)) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
  }
  if (typeof HTMLCanvasElement !== 'undefined') {
    const proto = HTMLCanvasElement.prototype as unknown as { getContext?: () => null };
    if (!proto.getContext) proto.getContext = () => null;
  }
});

function captureTerminalOnOpen(): { instance: () => Terminal | undefined; restore: () => void } {
  const originalOpen = Terminal.prototype.open;
  let captured: Terminal | undefined;
  const openSpy = vi
    .spyOn(Terminal.prototype, 'open')
    .mockImplementation(function (this: Terminal, parent: HTMLElement) {
      captured = this;
      return originalOpen.call(this, parent);
    });
  return {
    instance: () => captured,
    restore: () => openSpy.mockRestore(),
  };
}

function createFakeClient(): RelayClient {
  return {
    connect: vi.fn(),
    retry: vi.fn(),
    send: vi.fn(async () => undefined),
    close: vi.fn(),
    onMessage: vi.fn((_handler: (message: MobileServerMessage) => void) => () => {}),
    onStatus: vi.fn((_handler: (status: PhoneConnectionStatus) => void) => () => {}),
  };
}

describe('phonePage read-only terminal contract (Task 4 stale-behavior removal)', () => {
  let cleanups: Array<() => void> = [];

  afterEach(async () => {
    // Let any in-flight RAF-driven internal rendering settle before disposing
    // the terminal (mirrors tests/terminal/reloadInputContract.test.ts) so a
    // stray async render callback doesn't fire against an already-disposed
    // terminal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* best-effort */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it('constructs the terminal read-only: disableStdin true, cursorBlink false', () => {
    // Capture the live instance via a pass-through spy on `open` (the
    // constructor call itself isn't spy-able on a real ES module export),
    // then read its own configured options back.
    const capture = captureTerminalOnOpen();
    cleanups.push(capture.restore);

    const root = document.createElement('div');
    const dispose = createPhonePage(root, createFakeClient());
    cleanups.push(dispose);

    const captured = capture.instance();
    expect(captured).toBeDefined();
    expect(captured!.options.disableStdin).toBe(true);
    expect(captured!.options.cursorBlink).toBe(false);
  });

  it('never calls terminal.onData', () => {
    // `onData` is a getter (`get onData() { return this._core.onData; }`);
    // spying with the 'get' accessor type wraps the getter function itself
    // without invoking it, so this proves the getter is never *read* by
    // production code (i.e., no `terminal.onData(...)` subscription).
    const onDataGetterSpy = vi.spyOn(Terminal.prototype, 'onData', 'get');
    cleanups.push(() => onDataGetterSpy.mockRestore());
    const root = document.createElement('div');
    const dispose = createPhonePage(root, createFakeClient());
    cleanups.push(dispose);

    expect(onDataGetterSpy).not.toHaveBeenCalled();
  });

  it('never calls terminal.focus(), including on click/touch interaction with the terminal pane', () => {
    const focusSpy = vi.spyOn(Terminal.prototype, 'focus');
    cleanups.push(() => focusSpy.mockRestore());
    const root = document.createElement('div');
    const dispose = createPhonePage(root, createFakeClient());
    cleanups.push(dispose);

    const terminalElement = root.querySelector('#terminal') as HTMLElement;
    terminalElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    terminalElement.dispatchEvent(new Event('touchend', { bubbles: true }));
    terminalElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('renders only fixed, explicit-data hard keys (no sticky Ctrl toggle) that send session.input without focusing', () => {
    const focusSpy = vi.spyOn(Terminal.prototype, 'focus');
    cleanups.push(() => focusSpy.mockRestore());
    const client = createFakeClient();
    const root = document.createElement('div');
    const dispose = createPhonePage(root, client);
    cleanups.push(dispose);

    const buttons = Array.from(root.querySelectorAll('#keybar button'));
    // No standalone modal/sticky "Ctrl" toggle key remains.
    expect(buttons.some((button) => button.textContent === 'Ctrl')).toBe(false);
    expect(buttons.length).toBeGreaterThan(0);

    // Clicking a hard key with no active session is a no-op (no throw, no
    // send) — and never focuses the terminal.
    const escButton = buttons.find((button) => button.textContent === 'Esc')!;
    escButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(client.send).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('sends explicit session.input for a hard key once a session is active, without focusing', async () => {
    const focusSpy = vi.spyOn(Terminal.prototype, 'focus');
    cleanups.push(() => focusSpy.mockRestore());
    const client = createFakeClient();
    let messageHandler: ((message: MobileServerMessage) => void) | undefined;
    (client.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (handler: (message: MobileServerMessage) => void) => {
        messageHandler = handler;
        return () => {};
      },
    );
    const root = document.createElement('div');
    const dispose = createPhonePage(root, client);
    cleanups.push(dispose);

    messageHandler?.({
      type: 'sessions.list',
      sessions: [{ sid: 'sid-1', cwd: '/tmp/project', cols: 80, rows: 24 }],
    } as MobileServerMessage);

    const buttons = Array.from(root.querySelectorAll('#keybar button'));
    const enterButton = buttons.find((button) => button.textContent === 'Enter')!;
    enterButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const sendCalls = (client.send as ReturnType<typeof vi.fn>).mock.calls as [
      MobileClientMessage,
    ][];
    const inputCall = sendCalls.find(([message]) => message.type === 'session.input');
    expect(inputCall?.[0]).toMatchObject({ type: 'session.input', sid: 'sid-1', data: '\r' });
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
