import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock xterm constructors BEFORE importing the hook so the singleton
// uses the spies. Use vi.hoisted because vi.mock factories run before
// any top-level `const`.
const { openSpy, loadAddonSpy, onSelectionChangeSpy, attachCustomKeyEventHandlerSpy, terminalCtor } =
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
    return { openSpy, loadAddonSpy, onSelectionChangeSpy, attachCustomKeyEventHandlerSpy, terminalCtor };
  });

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

import { useXtermSingleton } from '../../src/terminal/useXtermSingleton';
import { __resetSingletonForTests } from '../../src/terminal/xtermSingleton';

describe('useXtermSingleton', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    terminalCtor.mockClear();
    openSpy.mockClear();
    loadAddonSpy.mockClear();
  });

  afterEach(() => {
    __resetSingletonForTests();
  });

  it('does NOT create xterm on first mount when window.ccsmPty is absent (wire-gate closed)', () => {
    // Spec #592 T-4 / Task #603 (PR-4): wire-then-instantiate. With a bare
    // jsdom window (no `window.ccsmPty`), the hook must be a no-op even when
    // `enabled` defaults true and the host ref is live. Original assertion
    // "always creates xterm" was overturned by the new wire gate; the
    // bring-up path (with the wire present) is covered in
    // useXtermSingleton.wire-gate.test.tsx.
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(onSelectionChangeSpy).not.toHaveBeenCalled();
    expect(attachCustomKeyEventHandlerSpy).not.toHaveBeenCalled();
  });

  it('does NOT create xterm across remounts when window.ccsmPty is absent', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    const r1 = renderHook(() => useXtermSingleton(ref));
    r1.unmount();
    const r2 = renderHook(() => useXtermSingleton(ref));
    r2.unmount();
    // No wire across both mounts → ctor never called. Singleton-cache
    // semantics under an open wire are covered in the wire-gate suite.
    expect(terminalCtor).not.toHaveBeenCalled();
  });

  it('no-ops when hostRef.current is null', () => {
    const ref = { current: null };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).not.toHaveBeenCalled();
  });
});
