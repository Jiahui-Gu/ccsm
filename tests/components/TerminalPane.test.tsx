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
// All four terminal hooks are mocked to no-ops so the pane mounts
// without instantiating xterm or attaching to a PTY — the test is
// strictly about the right-click wiring.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const { copySpy, pasteSpy } = vi.hoisted(() => ({
  copySpy: vi.fn(),
  pasteSpy: vi.fn(),
}));

vi.mock('../../src/terminal/useXtermSingleton', () => ({
  useXtermSingleton: () => undefined,
}));
vi.mock('../../src/terminal/useTerminalResize', () => ({
  useTerminalResize: () => undefined,
}));
vi.mock('../../src/terminal/usePtyAttach', () => ({
  // Return a `ready` state so the pane doesn't render the Attaching /
  // Error / Exit overlay layers — they're orthogonal to right-click
  // and rendering them just adds noise.
  usePtyAttach: () => ({ state: { kind: 'ready' }, onRetry: vi.fn() }),
}));
vi.mock('../../src/terminal/useAtBottom', () => ({
  useAtBottom: () => ({ atBottom: true, scrollToBottom: vi.fn() }),
}));
vi.mock('../../src/terminal/xtermSingleton', () => ({
  terminalCopy: copySpy,
  terminalPaste: pasteSpy,
}));
vi.mock('../../src/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// Skip xterm CSS import in jsdom (jsdom doesn't load CSS anyway, but the
// import resolver still walks the path).
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
  // `fireEvent.contextMenu` dispatches a real MouseEvent with the right
  // type; React's onContextMenu hands the SyntheticEvent through so
  // preventDefault on the synthetic event reaches the underlying native
  // event via the React event pool.
  const result = fireEvent.contextMenu(host);
  return { host, result };
}

describe('TerminalPane right-click (Task #41)', () => {
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
    // `fireEvent` returns false when the event was preventDefault-ed.
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
    expect(shell.suppressContextMenuOnce).toHaveBeenCalledTimes(1);
  });

  it('survives when ccsmShell bridge is missing (e2e probes / test harnesses)', () => {
    // Bridge intentionally not installed — the optional-chain in the
    // handler must keep the copy/paste branching alive.
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
    // Paste still ran despite the IPC throw.
    expect(pasteSpy).toHaveBeenCalledTimes(1);
  });
});
