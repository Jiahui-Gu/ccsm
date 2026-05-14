import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock xterm constructors BEFORE importing the hook so the singleton
// uses the spies. Use vi.hoisted because vi.mock factories run before
// any top-level `const`.
const {
  openSpy,
  loadAddonSpy,
  onSelectionChangeSpy,
  attachCustomKeyEventHandlerSpy,
  getSelectionSpy,
  pasteSpy,
  terminalCtor,
  webLinksCtor,
} = vi.hoisted(() => {
  const openSpy = vi.fn();
  const loadAddonSpy = vi.fn();
  const onSelectionChangeSpy = vi.fn();
  const attachCustomKeyEventHandlerSpy = vi.fn();
  const getSelectionSpy = vi.fn(() => '');
  const pasteSpy = vi.fn();
  // vitest v3+ requires `function`/`class` (not arrow) for mocks invoked
  // with `new` — otherwise tinyspy throws "is not a constructor".
  const terminalCtor = vi.fn(function () {
    return {
      open: openSpy,
      loadAddon: loadAddonSpy,
      onSelectionChange: onSelectionChangeSpy,
      attachCustomKeyEventHandler: attachCustomKeyEventHandlerSpy,
      getSelection: getSelectionSpy,
      paste: pasteSpy,
      unicode: { activeVersion: '6' },
      _core: { _parent: null },
    };
  });
  const webLinksCtor = vi.fn(function () {
    return {};
  });
  return {
    openSpy,
    loadAddonSpy,
    onSelectionChangeSpy,
    attachCustomKeyEventHandlerSpy,
    getSelectionSpy,
    pasteSpy,
    terminalCtor,
    webLinksCtor,
  };
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
    attachCustomKeyEventHandlerSpy.mockClear();
    getSelectionSpy.mockClear();
    getSelectionSpy.mockReturnValue('');
    pasteSpy.mockClear();
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

  describe('custom key event handler — paste duplication fix', () => {
    // Regression coverage for the paste-duplication bug: the custom
    // handler previously had Ctrl+V / Ctrl+Shift+V branches that wrote
    // pasted text to the PTY directly while xterm's built-in textarea
    // paste pipeline (term.paste → onData → pty.write) ALSO fired,
    // causing paste to be sent twice. The fix removes those branches
    // so paste flows exclusively through xterm's built-in pipeline.

    function installHandler() {
      const host = document.createElement('div');
      const ref = { current: host };
      renderHook(() => useXtermSingleton(ref));
      const handler = attachCustomKeyEventHandlerSpy.mock.calls[0][0] as (
        ev: Partial<KeyboardEvent>,
      ) => boolean;
      return handler;
    }

    let inputSpy: ReturnType<typeof vi.fn>;
    let writeTextSpy: ReturnType<typeof vi.fn>;
    let readTextSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      inputSpy = vi.fn();
      writeTextSpy = vi.fn();
      readTextSpy = vi.fn(() => 'clipboard-text');
      (window as unknown as { ccsmPty: unknown }).ccsmPty = {
        input: inputSpy,
        clipboard: { readText: readTextSpy, writeText: writeTextSpy },
      };
      setActiveSid('sid-1');
    });

    afterEach(() => {
      setActiveSid(null);
      delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    });

    it('returns true on Ctrl+V keydown (defers to xterm built-in paste pipeline)', () => {
      const handler = installHandler();
      const ev = {
        type: 'keydown' as const,
        key: 'v',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
      };
      const result = handler(ev);
      // Must return true so xterm core does NOT short-circuit; the
      // browser's native `paste` clipboard event reaches xterm's
      // textarea listener and flows through term.paste() → onData.
      expect(result).toBe(true);
      // Custom PTY write path is removed — must not be invoked here.
      expect(inputSpy).not.toHaveBeenCalled();
      expect(readTextSpy).not.toHaveBeenCalled();
    });

    it('returns true on Ctrl+Shift+V keydown (defers to xterm built-in paste pipeline)', () => {
      const handler = installHandler();
      const ev = {
        type: 'keydown' as const,
        key: 'V',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      };
      const result = handler(ev);
      expect(result).toBe(true);
      expect(inputSpy).not.toHaveBeenCalled();
      expect(readTextSpy).not.toHaveBeenCalled();
    });

    it('Ctrl+C with selection copies to clipboard and returns false', () => {
      getSelectionSpy.mockReturnValue('selected text');
      const handler = installHandler();
      const ev = {
        type: 'keydown' as const,
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
      };
      const result = handler(ev);
      expect(writeTextSpy).toHaveBeenCalledWith('selected text');
      expect(result).toBe(false);
    });

    it('Ctrl+C without selection returns true (falls through to SIGINT)', () => {
      getSelectionSpy.mockReturnValue('');
      const handler = installHandler();
      const ev = {
        type: 'keydown' as const,
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
      };
      const result = handler(ev);
      expect(writeTextSpy).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('Ctrl+Shift+C with selection always copies and returns false', () => {
      getSelectionSpy.mockReturnValue('selected text');
      const handler = installHandler();
      const ev = {
        type: 'keydown' as const,
        key: 'C',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      };
      const result = handler(ev);
      expect(writeTextSpy).toHaveBeenCalledWith('selected text');
      expect(result).toBe(false);
    });
  });

  describe('host-level paste listener (v0.2.2 paste-zero-times fix)', () => {
    // Regression coverage for the v0.2.1 user report: Ctrl+V paste fired
    // 0 times. Root cause: xterm's built-in paste pipeline only fires
    // when the hidden helper textarea has focus; in practice focus is
    // often elsewhere in the host wrapper, so the native `paste` event
    // never reached xterm. Fix: capture-phase paste listener on the host
    // element that routes through `term.paste(text)`.

    function mountAndGetHost() {
      const host = document.createElement('div');
      // Attach to document so dispatched events bubble through the real
      // event flow (capture listeners run regardless of attachment, but
      // we mirror prod conditions).
      document.body.appendChild(host);
      const ref = { current: host };
      renderHook(() => useXtermSingleton(ref));
      return host;
    }

    function makePasteEvent(text: string | null) {
      // jsdom's ClipboardEvent constructor doesn't accept clipboardData
      // in init dict, so synthesize via Event + assign a stub. The
      // production listener only reads `ev.clipboardData?.getData(...)`,
      // `ev.preventDefault`, and `ev.stopPropagation`.
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', {
        value: text === null
          ? null
          : { getData: vi.fn((_type: string) => text) },
      });
      return ev;
    }

    it('routes paste through term.paste once and prevents default', () => {
      const host = mountAndGetHost();
      const ev = makePasteEvent('hello world');
      const preventSpy = vi.spyOn(ev, 'preventDefault');
      const stopSpy = vi.spyOn(ev, 'stopPropagation');

      host.dispatchEvent(ev);

      expect(pasteSpy).toHaveBeenCalledTimes(1);
      expect(pasteSpy).toHaveBeenCalledWith('hello world');
      expect(preventSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalledTimes(1);

      document.body.removeChild(host);
    });

    it('does not call term.paste when clipboard text is empty', () => {
      const host = mountAndGetHost();
      const ev = makePasteEvent('');
      const preventSpy = vi.spyOn(ev, 'preventDefault');

      host.dispatchEvent(ev);

      expect(pasteSpy).not.toHaveBeenCalled();
      // No-op path: don't preventDefault so other handlers can decide.
      expect(preventSpy).not.toHaveBeenCalled();

      document.body.removeChild(host);
    });
  });
});
