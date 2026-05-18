import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock xterm constructors BEFORE importing the hook so the singleton
// uses the spies. Use vi.hoisted because vi.mock factories run before
// any top-level `const`.
const { openSpy, loadAddonSpy, onSelectionChangeSpy, attachCustomKeyEventHandlerSpy, terminalCtor, webLinksCtor } =
  vi.hoisted(() => {
    const openSpy = vi.fn();
    const loadAddonSpy = vi.fn();
    const onSelectionChangeSpy = vi.fn();
    const attachCustomKeyEventHandlerSpy = vi.fn();
    // vitest v3+ requires `function`/`class` (not arrow) for mocks invoked
    // with `new` — otherwise tinyspy throws "is not a constructor".
    const terminalCtor = vi.fn(function () {
      return {
        open: openSpy,
        loadAddon: loadAddonSpy,
        onSelectionChange: onSelectionChangeSpy,
        attachCustomKeyEventHandler: attachCustomKeyEventHandlerSpy,
        unicode: { activeVersion: '6' },
        _core: { _parent: null },
      };
    });
    const webLinksCtor = vi.fn(function () {
      return {};
    });
    return { openSpy, loadAddonSpy, onSelectionChangeSpy, attachCustomKeyEventHandlerSpy, terminalCtor, webLinksCtor };
  });

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: webLinksCtor }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

import { useXtermSingleton } from '../../src/terminal/useXtermSingleton';
import {
  __resetSingletonForTests,
  getTerm,
  setActiveSid,
} from '../../src/terminal/xtermSingleton';

describe('useXtermSingleton', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    terminalCtor.mockClear();
    openSpy.mockClear();
    loadAddonSpy.mockClear();
    webLinksCtor.mockClear();
  });

  afterEach(() => {
    __resetSingletonForTests();
  });

  it('creates the Terminal singleton on first mount', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(host);
    // Selection→clipboard wiring + custom key handler installed.
    expect(onSelectionChangeSpy).toHaveBeenCalledTimes(1);
    expect(attachCustomKeyEventHandlerSpy).toHaveBeenCalledTimes(1);
    // Probe handle exposed for e2e harness.
    expect(window.__ccsmTerm).toBe(getTerm());
  });

  it('reuses the singleton across remounts (does NOT recreate)', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    const r1 = renderHook(() => useXtermSingleton(ref));
    r1.unmount();
    const r2 = renderHook(() => useXtermSingleton(ref));
    r2.unmount();
    // ctor called exactly once across both mounts — proves cache hit.
    expect(terminalCtor).toHaveBeenCalledTimes(1);
  });

  it('no-ops when hostRef.current is null', () => {
    const ref = { current: null };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).not.toHaveBeenCalled();
  });

  describe('WebLinksAddon Ctrl/Cmd-click handler', () => {
    // The handler is the first ctor arg to `new WebLinksAddon(handler)`.
    // We extract it from the mock to exercise the modifier-gate without
    // touching the live xterm DOM.
    function getHandler(): (ev: { ctrlKey?: boolean; metaKey?: boolean }, uri: string) => void {
      const host = document.createElement('div');
      renderHook(() => useXtermSingleton({ current: host }));
      expect(webLinksCtor).toHaveBeenCalledTimes(1);
      const handler = webLinksCtor.mock.calls[0][0];
      expect(typeof handler).toBe('function');
      return handler as (ev: { ctrlKey?: boolean; metaKey?: boolean }, uri: string) => void;
    }

    beforeEach(() => {
      // Install a fresh openExternal spy on window.ccsm for each case.
      (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } }).ccsm = {
        openExternal: vi.fn(),
      };
    });

    afterEach(() => {
      delete (window as unknown as { ccsm?: unknown }).ccsm;
    });

    it('opens external on Ctrl+click (Windows/Linux convention)', () => {
      const handler = getHandler();
      handler({ ctrlKey: true, metaKey: false }, 'https://example.com');
      const spy = (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } })
        .ccsm.openExternal;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('https://example.com');
    });

    it('opens external on Cmd+click (macOS convention)', () => {
      const handler = getHandler();
      handler({ ctrlKey: false, metaKey: true }, 'https://example.com/path');
      const spy = (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } })
        .ccsm.openExternal;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('https://example.com/path');
    });

    it('does NOT open external on plain click (no modifier)', () => {
      const handler = getHandler();
      handler({ ctrlKey: false, metaKey: false }, 'https://example.com');
      const spy = (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } })
        .ccsm.openExternal;
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not throw when window.ccsm bridge is unavailable', () => {
      const handler = getHandler();
      delete (window as unknown as { ccsm?: unknown }).ccsm;
      expect(() =>
        handler({ ctrlKey: true, metaKey: false }, 'https://example.com'),
      ).not.toThrow();
    });
  });

  // Paste behaviour — the core regression test for v0.2.0 double-paste
  // and v0.2.1/v0.2.2 zero-paste. Both prior fixes had unit tests that
  // passed; both failed in the real app. These tests exercise the actual
  // wiring: the keydown hook installed via `attachCustomKeyEventHandler`,
  // the capture-phase paste listener installed on the host element, and
  // the handoff flag that prevents double-injection.
  describe('paste behaviour', () => {
    let inputSpy: ReturnType<typeof vi.fn>;
    let readTextSpy: ReturnType<typeof vi.fn>;
    let host: HTMLDivElement;

    function getKeyHandler(): (ev: {
      type: string;
      key: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
    }) => boolean {
      const handler = attachCustomKeyEventHandlerSpy.mock.calls[0][0];
      expect(typeof handler).toBe('function');
      return handler;
    }

    beforeEach(() => {
      inputSpy = vi.fn();
      readTextSpy = vi.fn().mockReturnValue('hello');
      (window as unknown as { ccsmPty: unknown }).ccsmPty = {
        input: inputSpy,
        clipboard: {
          readText: readTextSpy,
          writeText: vi.fn(),
        },
      };
      // The hook receives a real DOM node so the capture-phase paste
      // listener it installs is exercised by real events.
      host = document.createElement('div');
      document.body.appendChild(host);
      renderHook(() => useXtermSingleton({ current: host }));
      // setActiveSid is module-internal; the hook leaves activeSid at
      // null until usePtyAttach wires it. Set it directly via the
      // exported setter so the paste path is reachable.
      setActiveSid('sid-1');
    });

    afterEach(() => {
      document.body.removeChild(host);
      delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    });

    function makePasteEvent(text: string): ClipboardEvent {
      // jsdom doesn't implement DataTransfer; we synthesize a minimal
      // ClipboardEvent + clipboardData shim sufficient for the handler.
      const evt = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(evt, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
      });
      return evt;
    }

    it('Ctrl+V keydown injects clipboard text exactly once', () => {
      const handler = getKeyHandler();
      const ret = handler({ type: 'keydown', key: 'v', ctrlKey: true });
      expect(ret).toBe(false);
      expect(readTextSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-1', 'hello');
    });

    it('Cmd+V keydown injects clipboard text exactly once (macOS)', () => {
      const handler = getKeyHandler();
      const ret = handler({ type: 'keydown', key: 'v', metaKey: true });
      expect(ret).toBe(false);
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-1', 'hello');
    });

    it('keydown-driven paste suppresses the follow-up native paste event', () => {
      const handler = getKeyHandler();
      handler({ type: 'keydown', key: 'v', ctrlKey: true });
      expect(inputSpy).toHaveBeenCalledTimes(1);

      // The browser's native paste event arrives after our synchronous
      // keydown handling. It must be swallowed, not turned into a second
      // ccsmPty.input call.
      const evt = makePasteEvent('hello');
      host.dispatchEvent(evt);
      expect(inputSpy).toHaveBeenCalledTimes(1);
    });

    it('right-click / context-menu paste (no preceding keydown) injects once', () => {
      const evt = makePasteEvent('world');
      host.dispatchEvent(evt);
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-1', 'world');
      // xterm's built-in paste pipeline must not see the event.
      expect(evt.defaultPrevented).toBe(true);
    });

    it('handoff flag clears so a later non-keyboard paste is not silently dropped', async () => {
      const handler = getKeyHandler();
      // Keyboard paste with NO follow-up native event (e.g. focus on
      // canvas — browser doesn't dispatch paste to non-editable nodes).
      handler({ type: 'keydown', key: 'v', ctrlKey: true });
      expect(inputSpy).toHaveBeenCalledTimes(1);

      // Wait for the macrotask that resets the flag. We use setTimeout 0
      // (not queueMicrotask) because the browser's native paste event
      // arrives AFTER microtasks but BEFORE the next task tick, so a
      // microtask reset would race the suppression. A real timer tick
      // has to elapse for the reset to fire.
      await new Promise((r) => setTimeout(r, 10));

      // A later paste from a different source must still be delivered.
      const evt = makePasteEvent('later');
      host.dispatchEvent(evt);
      expect(inputSpy).toHaveBeenCalledTimes(2);
      expect(inputSpy).toHaveBeenLastCalledWith('sid-1', 'later');
    });

    it('Ctrl+V is a no-op when no active session', () => {
      setActiveSid(null);
      const handler = getKeyHandler();
      handler({ type: 'keydown', key: 'v', ctrlKey: true });
      expect(inputSpy).not.toHaveBeenCalled();
    });
  });
});
