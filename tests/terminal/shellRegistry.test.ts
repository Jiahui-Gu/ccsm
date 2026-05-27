// Tests for shellRegistry — the post-attach-redesign per-session shell
// lifecycle module. Modelled on tests/terminal/xtermWarmRegistry.test.ts:
// xterm constructors are vi.mocked so jsdom doesn't spin up real renderers,
// the store + window.ccsmPty + window.ccsm are stubbed, and we assert the
// observable contract (DOM tree, mask/z-index/display flips, store calls,
// dispatched data chunks).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { terminalCtor, fitCtor } = vi.hoisted(() => {
  const terminalCtor = vi.fn(function () {
    const inst = {
      open: vi.fn(),
      loadAddon: vi.fn(),
      write: vi.fn(),
      dispose: vi.fn(),
      reset: vi.fn(),
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      resize: vi.fn(),
      getSelection: vi.fn(() => ''),
      selectAll: vi.fn(),
      cols: 80,
      rows: 24,
      textarea: document.createElement('textarea'),
      unicode: { activeVersion: '6' },
      buffer: { active: { viewportY: 0, baseY: 0 } },
      options: { scrollback: 1000, fontSize: 13 },
    };
    return inst;
  });
  const fitCtor = vi.fn(function () {
    return { fit: vi.fn() };
  });
  return { terminalCtor, fitCtor };
});

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: fitCtor }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

vi.mock('../../src/shared/log', () => ({
  log: { event: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  error: vi.fn(),
}));

const { applyPtyExitSpy } = vi.hoisted(() => ({ applyPtyExitSpy: vi.fn() }));
vi.mock('../../src/stores/store', () => {
  const state = {
    scrollbackLines: 1000,
    terminalFontSizePx: 13,
    _applyPtyExit: applyPtyExitSpy,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useStore = ((selector: (s: any) => any) => selector(state)) as any;
  useStore.getState = () => state;
  useStore.setState = () => undefined;
  return { useStore };
});

vi.mock('../../src/terminal/paste', () => ({
  pasteIntoActivePty: vi.fn(),
}));

import {
  createShell,
  disposeShell,
  disposeAll,
  getShell,
  getTopShell,
  getTopSid,
  shellCount,
  showShell,
  setMask,
  subscribeShellData,
  resetShellForReload,
  applyTerminalFontSize,
  applyTerminalScrollback,
  __resetShellRegistryForTests,
} from '../../src/terminal/shellRegistry';

describe('shellRegistry', () => {
  let host: HTMLDivElement;
  let onDataListeners: Array<(p: { sid: string; chunk: string; seq: number }) => void>;
  let onExitListeners: Array<(p: { sessionId: string; code?: number | null; signal?: string | number | null }) => void>;
  let resizeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onDataListeners = [];
    onExitListeners = [];
    resizeSpy = vi.fn(() => Promise.resolve());
    (window as unknown as { ccsmPty: unknown }).ccsmPty = {
      onData: (cb: (p: { sid: string; chunk: string; seq: number }) => void) => {
        onDataListeners.push(cb);
        return () => {
          const i = onDataListeners.indexOf(cb);
          if (i >= 0) onDataListeners.splice(i, 1);
        };
      },
      onExit: (cb: (p: { sessionId: string; code?: number | null; signal?: string | number | null }) => void) => {
        onExitListeners.push(cb);
        return () => {
          const i = onExitListeners.indexOf(cb);
          if (i >= 0) onExitListeners.splice(i, 1);
        };
      },
      resize: resizeSpy,
      clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
    };
    (window as unknown as { ccsm: unknown }).ccsm = { openExternal: vi.fn() };
    host = document.createElement('div');
    document.body.appendChild(host);
    terminalCtor.mockClear();
    applyPtyExitSpy.mockClear();
  });

  afterEach(() => {
    __resetShellRegistryForTests();
    if (host.parentElement) document.body.removeChild(host);
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    delete (window as unknown as { ccsm?: unknown }).ccsm;
    delete (window as unknown as { __ccsmTerm?: unknown }).__ccsmTerm;
  });

  it('createShell builds a wrapper + mask under the host and promotes to top', () => {
    const shell = createShell('sid-a', host);
    expect(shell.sid).toBe('sid-a');
    expect(shell.wrapper.parentElement).toBe(host);
    expect(shell.mask.parentElement).toBe(shell.wrapper);
    expect(shell.wrapper.style.zIndex).toBe('2');
    expect(getTopSid()).toBe('sid-a');
    expect(getTopShell()).toBe(shell);
    expect(shellCount()).toBe(1);
    expect(terminalCtor).toHaveBeenCalledTimes(1);
    // term.open() was called against the wrapper
    const term = terminalCtor.mock.results[0].value as { open: ReturnType<typeof vi.fn> };
    expect(term.open).toHaveBeenCalledWith(shell.wrapper);
  });

  it('createShell with an existing sid is idempotent — returns the same shell and promotes', () => {
    const a = createShell('sid-a', host);
    const b = createShell('sid-b', host);
    expect(getTopSid()).toBe('sid-b');
    // Re-creating sid-a returns the same shell and flips it back to top.
    terminalCtor.mockClear();
    const aAgain = createShell('sid-a', host);
    expect(aAgain).toBe(a);
    expect(terminalCtor).not.toHaveBeenCalled();
    expect(getTopSid()).toBe('sid-a');
    expect(a.wrapper.style.zIndex).toBe('2');
    expect(b.wrapper.style.display).toBe('none');
    expect(b.wrapper.style.zIndex).toBe('1');
  });

  it('showShell hides others (display:none) and promotes target (z-index 2)', () => {
    const a = createShell('sid-a', host);
    const b = createShell('sid-b', host);
    expect(a.wrapper.style.display).toBe('none');
    expect(b.wrapper.style.display).toBe('');
    showShell('sid-a');
    expect(a.wrapper.style.display).toBe('');
    expect(a.wrapper.style.zIndex).toBe('2');
    expect(b.wrapper.style.display).toBe('none');
    expect(b.wrapper.style.zIndex).toBe('1');
    expect(getTopSid()).toBe('sid-a');
    // window.__ccsmTerm exposed for the probe.
    expect((window as unknown as { __ccsmTerm?: unknown }).__ccsmTerm).toBe(a.term);
  });

  it('showShell on unknown sid returns undefined and leaves state untouched', () => {
    createShell('sid-a', host);
    const before = getTopSid();
    expect(showShell('nope')).toBeUndefined();
    expect(getTopSid()).toBe(before);
  });

  it('showShell consumes pendingFontSize and triggers fit+pty.resize when warmed', () => {
    const a = createShell('sid-a', host);
    createShell('sid-b', host);
    // sid-a is hidden; stash a deferred font size on it.
    a.warmed = true;
    a.pendingFontSize = 18;
    showShell('sid-a');
    expect(a.pendingFontSize).toBeNull();
    expect((a.term.options as { fontSize?: number }).fontSize).toBe(18);
    expect(a.fit.fit).toHaveBeenCalled();
    expect(resizeSpy).toHaveBeenCalledWith('sid-a', 80, 24);
  });

  it('setMask toggles the mask div display', () => {
    createShell('sid-a', host);
    setMask('sid-a', false);
    const shell = getShell('sid-a')!;
    expect(shell.mask.style.display).toBe('none');
    setMask('sid-a', true);
    expect(shell.mask.style.display).toBe('');
    // No-op on unknown sid.
    expect(() => setMask('nope', true)).not.toThrow();
  });

  it('subscribeShellData routes chunks to the matching sid and ignores others', () => {
    createShell('sid-a', host);
    createShell('sid-b', host);
    subscribeShellData('sid-a');
    subscribeShellData('sid-b');
    const termA = terminalCtor.mock.results[0].value as { write: ReturnType<typeof vi.fn> };
    const termB = terminalCtor.mock.results[1].value as { write: ReturnType<typeof vi.fn> };
    termA.write.mockClear();
    termB.write.mockClear();
    // Two independent listeners installed.
    expect(onDataListeners.length).toBe(2);
    // Fire a chunk for sid-a; only termA receives it.
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'hello', seq: 1 });
    expect(termA.write).toHaveBeenCalledWith('hello');
    expect(termB.write).not.toHaveBeenCalled();
    // Fire a chunk for sid-b; only termB receives it.
    for (const cb of onDataListeners) cb({ sid: 'sid-b', chunk: 'world', seq: 1 });
    expect(termB.write).toHaveBeenCalledWith('world');
  });

  it('subscribeShellData re-subscription disposes the previous unsubscribe', () => {
    createShell('sid-a', host);
    subscribeShellData('sid-a');
    expect(onDataListeners.length).toBe(1);
    // Re-subscribe — previous unsubscribe is invoked, listener count stays 1.
    subscribeShellData('sid-a');
    expect(onDataListeners.length).toBe(1);
  });

  it('subscribeShellData buffers chunks while composing, drains on compositionend', () => {
    const a = createShell('sid-a', host);
    subscribeShellData('sid-a');
    const term = terminalCtor.mock.results[0].value as { write: ReturnType<typeof vi.fn> };
    term.write.mockClear();
    // Simulate IME composition: textarea fires compositionstart, then we
    // fan out chunks (they should be buffered, not written to term).
    const ta = a.term.textarea!;
    ta.dispatchEvent(new Event('compositionstart'));
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'A', seq: 1 });
    for (const cb of onDataListeners) cb({ sid: 'sid-a', chunk: 'B', seq: 2 });
    expect(term.write).not.toHaveBeenCalled();
    // compositionend drains the buffer.
    ta.dispatchEvent(new Event('compositionend'));
    expect(term.write).toHaveBeenCalledWith('AB');
  });

  it('disposeShell removes wrapper, disposes term, unsubscribes', () => {
    const a = createShell('sid-a', host);
    subscribeShellData('sid-a');
    expect(onDataListeners.length).toBe(1);
    expect(a.wrapper.parentElement).toBe(host);
    disposeShell('sid-a');
    expect(getShell('sid-a')).toBeUndefined();
    expect(shellCount()).toBe(0);
    expect(a.term.dispose).toHaveBeenCalledTimes(1);
    expect(a.wrapper.parentElement).toBeNull();
    expect(onDataListeners.length).toBe(0);
    expect(getTopSid()).toBeNull();
  });

  it('disposeShell of the top promotes the next remaining shell', () => {
    createShell('sid-a', host);
    createShell('sid-b', host);
    expect(getTopSid()).toBe('sid-b');
    disposeShell('sid-b');
    expect(getTopSid()).toBe('sid-a');
    const a = getShell('sid-a')!;
    expect(a.wrapper.style.display).toBe('');
    expect(a.wrapper.style.zIndex).toBe('2');
  });

  it('disposeShell on unknown sid is a no-op', () => {
    createShell('sid-a', host);
    expect(() => disposeShell('nope')).not.toThrow();
    expect(shellCount()).toBe(1);
  });

  it('disposeAll tears down every shell', () => {
    createShell('sid-a', host);
    createShell('sid-b', host);
    expect(shellCount()).toBe(2);
    disposeAll();
    expect(shellCount()).toBe(0);
    expect(getTopSid()).toBeNull();
  });

  it('resetShellForReload calls term.reset and masks if the sid is top', () => {
    createShell('sid-a', host);
    createShell('sid-b', host);
    // sid-b is top.
    const b = getShell('sid-b')!;
    b.mask.style.display = 'none';
    const result = resetShellForReload('sid-b');
    expect(result).toBe(b);
    expect(b.term.reset).toHaveBeenCalled();
    expect(b.mask.style.display).toBe('');
    // Reset on non-top doesn't touch the mask.
    const a = getShell('sid-a')!;
    a.mask.style.display = 'none';
    resetShellForReload('sid-a');
    expect(a.term.reset).toHaveBeenCalled();
    expect(a.mask.style.display).toBe('none');
  });

  it('resetShellForReload on unknown sid returns undefined', () => {
    expect(resetShellForReload('nope')).toBeUndefined();
  });

  it('applyTerminalFontSize applies immediately to top, stashes pending on hidden', async () => {
    const a = createShell('sid-a', host);
    const b = createShell('sid-b', host);
    // sid-b is top.
    a.warmed = true;
    b.warmed = true;
    await applyTerminalFontSize(22);
    // Top got an immediate apply.
    expect((b.term.options as { fontSize?: number }).fontSize).toBe(22);
    expect(b.fit.fit).toHaveBeenCalled();
    expect(resizeSpy).toHaveBeenCalledWith('sid-b', 80, 24);
    // Hidden has a deferred pending value.
    expect(a.pendingFontSize).toBe(22);
    expect((a.term.options as { fontSize?: number }).fontSize).toBe(13);
  });

  it('applyTerminalFontSize is a no-op on the top shell when the px matches the current size', async () => {
    const a = createShell('sid-a', host);
    (a.term.options as { fontSize?: number }).fontSize = 17;
    a.warmed = true;
    (a.fit.fit as ReturnType<typeof vi.fn>).mockClear();
    await applyTerminalFontSize(17);
    expect(a.fit.fit).not.toHaveBeenCalled();
  });

  it('applyTerminalScrollback updates options on every shell', () => {
    const a = createShell('sid-a', host);
    const b = createShell('sid-b', host);
    applyTerminalScrollback(5000);
    expect((a.term.options as { scrollback?: number }).scrollback).toBe(5000);
    expect((b.term.options as { scrollback?: number }).scrollback).toBe(5000);
  });

  it('does NOT install a module-level pty.onExit listener (bridge in App.tsx owns dispatch)', () => {
    // Regression for PR #1396's reload bug: a second listener here
    // caused dual-dispatch of `_applyPtyExit` per pty:exit IPC, which
    // defeated reloadSession's expectedExits suppression and surfaced
    // the "claude crashed" overlay on every healthy reload. The
    // app-level `usePtyExitBridge` is the only legitimate caller.
    createShell('sid-a', host);
    createShell('sid-b', host);
    expect(onExitListeners.length).toBe(0);
    expect(applyPtyExitSpy).not.toHaveBeenCalled();
  });
});
