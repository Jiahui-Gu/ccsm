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
});
