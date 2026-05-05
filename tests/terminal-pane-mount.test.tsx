// Spec #592 T-4 / Task #603 (PR-4) — TerminalPane host unconditional +
// xterm pin order.
//
// Three contract assertions:
//   1. mount-without-sid: the host element [data-terminal-host] is in the
//      DOM even when sessionId is null. xterm is NOT instantiated. This is
//      the e2e probe (`terminal-host-mounted`, follow-up #605 PR-8) latch
//      surface that lets the harness wait for the pane before any session
//      resolves.
//   2. wire-then-instantiate: xterm constructor runs only after BOTH
//      gates open — sessionId is a string AND `window.ccsmPty` is wired.
//      Flipping sid first while the bridge is missing is a no-op; xterm
//      lands on the next render where both gates are satisfied.
//   3. unmount-cleanup: on unmount the pty subscriber and input listener
//      are torn down (the disposables installed by usePtyAttach), and
//      `pty.detach(sid)` is called. Without these the singleton would
//      leak references to the previous attach across full pane unmounts.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Hoisted xterm spies — imported by xtermSingleton at module load. The
// constructor call count is the canonical "did xterm instantiate?" signal
// for the wire-then-instantiate pin order.
const { terminalCtor, openSpy, loadAddonSpy } = vi.hoisted(() => {
  const openSpy = vi.fn();
  const loadAddonSpy = vi.fn();
  // vitest v3 requires `function`/`class` (not arrow) for `new`-invoked mocks.
  const terminalCtor = vi.fn(function () {
    return {
      open: openSpy,
      loadAddon: loadAddonSpy,
      onSelectionChange: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      unicode: { activeVersion: '6' },
      _core: { _parent: null },
      // Surfaces touched by usePtyAttach when a sid is present:
      write: vi.fn(),
      reset: vi.fn(),
      resize: vi.fn(),
      focus: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      cols: 80,
      rows: 24,
    };
  });
  return { terminalCtor, openSpy, loadAddonSpy };
});

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function () {
    return { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })) };
  }),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

// xterm.css is fine to import in jsdom; the dummy keeps the load graph
// hermetic and avoids touching the real stylesheet from node_modules.
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// Minimal store + i18n stubs so the component can render in isolation.
vi.mock('../src/stores/store', () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({ _clearPtyExit: vi.fn() }),
}));
vi.mock('../src/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// ResizeObserver stub — jsdom doesn't ship one and useTerminalResize
// instantiates one unconditionally on mount.
class ROStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ROStub }).ResizeObserver = ROStub;

import { TerminalPane } from '../src/components/TerminalPane';
import { __resetSingletonForTests } from '../src/terminal/xtermSingleton';

type PtyBridge = {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  getBufferSnapshot: ReturnType<typeof vi.fn>;
};

function installPtyBridge(): { bridge: PtyBridge; onDataUnsub: ReturnType<typeof vi.fn> } {
  const onDataUnsub = vi.fn();
  const bridge: PtyBridge = {
    attach: vi.fn(async () => ({ snapshot: 'snap', cols: 80, rows: 24, pid: 1 })),
    detach: vi.fn(async () => undefined),
    spawn: vi.fn(async () => ({ ok: true as const, sid: 'x', pid: 1, cols: 80, rows: 24 })),
    input: vi.fn(),
    resize: vi.fn(async () => undefined),
    onData: vi.fn(() => onDataUnsub),
    onExit: vi.fn(() => vi.fn()),
    getBufferSnapshot: vi.fn(async () => ({ snapshot: 'snap', seq: 0 })),
  };
  (window as unknown as { ccsmPty: PtyBridge }).ccsmPty = bridge;
  return { bridge, onDataUnsub };
}

function clearPtyBridge(): void {
  delete (window as unknown as { ccsmPty?: PtyBridge }).ccsmPty;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const flushAll = async () => {
  await flush();
  await flush();
  await flush();
};

describe('TerminalPane host mount (spec #592 T-4 / Task #603 PR-4)', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    terminalCtor.mockClear();
    openSpy.mockClear();
    loadAddonSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
    clearPtyBridge();
    __resetSingletonForTests();
  });

  it('mount-without-sid: host element is in DOM and xterm is NOT instantiated', async () => {
    // Pty bridge wired but no session selected — the host must still mount.
    installPtyBridge();
    const { container } = render(<TerminalPane sessionId={null} cwd="" />);
    await flushAll();

    const host = container.querySelector('[data-terminal-host]');
    expect(host).not.toBeNull();
    // No active sid → no `data-active-sid` attribute (probes that need
    // an active session can require both attributes).
    expect(host?.getAttribute('data-active-sid')).toBeNull();
    // xterm pin order: nothing instantiated until a sid is provided.
    expect(terminalCtor).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('wire-then-instantiate: xterm constructor only runs after both sid AND window.ccsmPty are present', async () => {
    // Step 1: bridge missing, sid present. Pin order says no xterm yet.
    clearPtyBridge();
    const { rerender } = render(<TerminalPane sessionId="sid-A" cwd="/tmp" />);
    await flushAll();
    expect(terminalCtor).not.toHaveBeenCalled();

    // Step 2: bridge lands → re-render with the same sid. The hook's
    // `enabled` dep is unchanged across this render, but the pty-host
    // wire gate is now open. Re-render with a sid change forces the
    // singleton hook to re-run, confirming the pin order: wire FIRST,
    // then xterm instantiation.
    installPtyBridge();
    rerender(<TerminalPane sessionId="sid-B" cwd="/tmp" />);
    await flushAll();

    expect(terminalCtor).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalled();
  });

  it('unmount-cleanup: pty.detach is called and the data subscriber unsubscribes', async () => {
    const { onDataUnsub, bridge } = installPtyBridge();
    const { unmount } = render(<TerminalPane sessionId="sid-C" cwd="/tmp" />);
    await flushAll();

    expect(bridge.attach).toHaveBeenCalledWith('sid-C');
    expect(bridge.onData).toHaveBeenCalled();

    unmount();
    // Cleanup is synchronous from React's perspective; the detach call
    // is fire-and-forget so we only assert it was invoked.
    expect(bridge.detach).toHaveBeenCalledWith('sid-C');
    expect(onDataUnsub).toHaveBeenCalled();
  });
});
