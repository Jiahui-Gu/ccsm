import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mirror useXtermSingleton.test.tsx's mock setup so the hook resolves
// against spy constructors and never touches real xterm during the gate
// assertions. See comments there for the `vi.hoisted` + `function`
// rationale (vitest v3+ requires non-arrow factories for `new`).
const { openSpy, terminalCtor } = vi.hoisted(() => {
  const openSpy = vi.fn();
  const terminalCtor = vi.fn(function () {
    return {
      open: openSpy,
      loadAddon: vi.fn(),
      onSelectionChange: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      unicode: { activeVersion: '6' },
      _core: { _parent: null },
    };
  });
  return { openSpy, terminalCtor };
});

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

import { useXtermSingleton } from '../../src/terminal/useXtermSingleton';
import { __resetSingletonForTests, getTerm } from '../../src/terminal/xtermSingleton';

/**
 * Independent suite for the `window.ccsmPty` wire-gate added in PR #1118
 * (spec #592 T-4 / Task #603 PR-4). Kept separate from the main
 * useXtermSingleton suite so each gate state owns its own setup and there
 * is no shared, easy-to-overlook beforeEach toggling the bridge.
 *
 *   - case A (gate closed): no `window.ccsmPty` → hook MUST NOT instantiate
 *   - case B (gate open):   `window.ccsmPty` present → hook MUST instantiate
 */
describe('useXtermSingleton wire-gate (window.ccsmPty)', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    terminalCtor.mockClear();
    openSpy.mockClear();
    // Start every case from a bare jsdom window — each case explicitly
    // installs the bridge if it needs one, so the gate state is local
    // and visible.
    delete (window as unknown as { ccsmPty?: object }).ccsmPty;
  });

  afterEach(() => {
    __resetSingletonForTests();
    delete (window as unknown as { ccsmPty?: object }).ccsmPty;
  });

  it('case A: does NOT create xterm when window.ccsmPty is absent', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('case B: creates xterm when window.ccsmPty is present', () => {
    (window as unknown as { ccsmPty: object }).ccsmPty = {};
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(host);
    expect(window.__ccsmTerm).toBe(getTerm());
  });
});
