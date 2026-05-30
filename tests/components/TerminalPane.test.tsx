// Task #41: TerminalPane's native CLI/terminal-emulator right-click
// behavior. Replaces the global native context menu (Cut/Copy/Paste/
// SelectAll popup installed in electron/window/createWindow.ts) with
// immediate inline copy-on-selection / paste-on-empty, mirroring Windows
// Terminal and gnome-terminal. The host div's `onContextMenu`:
//   1. preventDefault + stopPropagation on the React event
//   2. sends `ccsmShell.suppressContextMenuOnce()` so main skips the
//      native popup (DOM preventDefault does NOT cancel Electron's
//      main-process `context-menu` event — separate one-shot needed)
//   3. branches on the selection: copy + clear OR paste
//
// The warm hook (`usePtyAttachWarm`), warm registry (`getActiveEntry`),
// and shared `paste` module are mocked so the pane mounts without
// instantiating xterm or attaching to a PTY — the test is strictly about
// the right-click wiring.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const { copySpy, pasteSpy, getTopShellSpy } = vi.hoisted(() => ({
  copySpy: vi.fn(),
  pasteSpy: vi.fn(),
  getTopShellSpy: vi.fn(() => ({ term: { id: 'fake-term' } })),
}));

vi.mock('../../src/terminal/usePtyAttachShell', () => ({
  usePtyAttachShell: () => ({ state: { kind: 'ready' }, onRetry: vi.fn() }),
}));
vi.mock('../../src/terminal/useAtBottom', () => ({
  useAtBottom: () => ({ atBottom: true, scrollToBottom: vi.fn() }),
}));
vi.mock('../../src/terminal/useTerminalScroll', () => ({
  useTerminalScroll: () => ({
    visible: false,
    thumbTop: 0,
    thumbHeight: 0,
    dragTo: vi.fn(),
    pageBy: vi.fn(),
  }),
}));
vi.mock('../../src/terminal/shellRegistry', () => ({
  getTopShell: getTopShellSpy,
  // store.ts registers an appearance provider at module-eval via this
  // export; the mock must surface it so importing the store doesn't throw.
  setShellAppearanceProvider: vi.fn(),
}));
vi.mock('../../src/terminal/paste', () => ({
  terminalCopy: copySpy,
  terminalPaste: pasteSpy,
}));
vi.mock('../../src/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// Skip xterm CSS import in jsdom.
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { TerminalPane } from '../../src/components/TerminalPane';

interface MockShell {
  suppressContextMenuOnce: ReturnType<typeof vi.fn>;
}

function installShellBridge(): MockShell {
  const bridge: MockShell = { suppressContextMenuOnce: vi.fn() };
  (window as unknown as { ccsmShell: MockShell }).ccsmShell = bridge;
  return bridge;
}

function fireContextMenuOnHost(container: HTMLElement) {
  const host = container.querySelector('[data-terminal-host]') as HTMLElement;
  expect(host).not.toBeNull();
  const result = fireEvent.contextMenu(host);
  return { host, result };
}

describe('TerminalPane right-click (Task #41, warm path)', () => {
  beforeEach(() => {
    copySpy.mockReset();
    pasteSpy.mockReset();
    delete (window as unknown as { ccsmShell?: unknown }).ccsmShell;
  });

  it('copy branch: with selection → terminalCopy, no paste, suppression sent, default prevented', () => {
    copySpy.mockReturnValue(true);
    const shell = installShellBridge();
    const { container } = render(<TerminalPane sessionId="sid-1" cwd="/tmp" />);
    const host = container.querySelector('[data-terminal-host]') as HTMLElement;
    const notPrevented = fireEvent.contextMenu(host);
    expect(notPrevented).toBe(false);
    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(pasteSpy).not.toHaveBeenCalled();
    expect(shell.suppressContextMenuOnce).toHaveBeenCalledTimes(1);
  });

  it('paste branch: no selection → terminalPaste, suppression sent, default prevented', () => {
    copySpy.mockReturnValue(false);
    const shell = installShellBridge();
    const { container } = render(<TerminalPane sessionId="sid-2" cwd="/tmp" />);
    const host = container.querySelector('[data-terminal-host]') as HTMLElement;
    const notPrevented = fireEvent.contextMenu(host);
    expect(notPrevented).toBe(false);
    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(pasteSpy).toHaveBeenCalledTimes(1);
    // terminalPaste signature: (getTerm, sid, branch)
    expect(pasteSpy.mock.calls[0]?.[1]).toBe('sid-2');
    expect(pasteSpy.mock.calls[0]?.[2]).toBe('right-click');
    expect(shell.suppressContextMenuOnce).toHaveBeenCalledTimes(1);
  });

  it('survives when ccsmShell bridge is missing (e2e probes / test harnesses)', () => {
    copySpy.mockReturnValue(true);
    const { container } = render(<TerminalPane sessionId="sid-3" cwd="/tmp" />);
    const host = container.querySelector('[data-terminal-host]') as HTMLElement;
    expect(() => fireEvent.contextMenu(host)).not.toThrow();
    expect(copySpy).toHaveBeenCalledTimes(1);
  });

  it('throwing suppressContextMenuOnce does not block the inline copy/paste', () => {
    copySpy.mockReturnValue(false);
    const bridge: MockShell = {
      suppressContextMenuOnce: vi.fn(() => {
        throw new Error('IPC unavailable');
      }),
    };
    (window as unknown as { ccsmShell: MockShell }).ccsmShell = bridge;
    const { container } = render(<TerminalPane sessionId="sid-4" cwd="/tmp" />);
    const { host } = fireContextMenuOnHost(container);
    expect(host).toBeTruthy();
    expect(pasteSpy).toHaveBeenCalledTimes(1);
  });
});
