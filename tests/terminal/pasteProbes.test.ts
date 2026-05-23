// PR B Stage 2 — paste probe events.
//
// Verifies `paste.branch`, `paste.normalized`, `paste.hop` events fire with
// the expected entry-point tags and metadata. We exercise the three paste
// entry-points (capture-DOM listener, Ctrl/Cmd+V keydown, right-click
// `terminalPaste`) via the public API, mocking `window.ccsmPty` so the IPC
// hops are observable without a real preload bridge.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { writeSpy, textarea, keyHandlerRef, terminalCtor } = vi.hoisted(() => {
  const writeSpy = vi.fn();
  const textarea = (globalThis as unknown as { document: Document }).document.createElement('textarea');
  const keyHandlerRef: { current: ((ev: KeyboardEvent) => boolean) | null } = { current: null };
  const terminalCtor = vi.fn(function () {
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      onSelectionChange: vi.fn(),
      attachCustomKeyEventHandler: vi.fn((cb: (ev: KeyboardEvent) => boolean) => {
        keyHandlerRef.current = cb;
      }),
      getSelection: vi.fn(() => ''),
      clearSelection: vi.fn(),
      selectAll: vi.fn(),
      unicode: { activeVersion: '6' },
      modes: { bracketedPasteMode: false },
      _core: { _parent: null },
      textarea,
      write: writeSpy,
    };
  });
  return { writeSpy, textarea, keyHandlerRef, terminalCtor };
});

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

const eventSpy = vi.fn();
vi.mock('../../src/shared/log', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: (...args: unknown[]) => eventSpy(...args),
  },
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  __resetSingletonForTests,
  ensureTerminal,
  setActiveSid,
  terminalPaste,
} from '../../src/terminal/xtermSingleton';

function fieldsFor(name: string): Array<Record<string, unknown>> {
  return eventSpy.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

function lastBranch(): string | undefined {
  const calls = fieldsFor('paste.branch');
  return calls[calls.length - 1]?.branch as string | undefined;
}

describe('paste probes — entry-point branch dispatch', () => {
  let host: HTMLDivElement;
  let inputSpy: ReturnType<typeof vi.fn>;
  let saveImageSpy: ReturnType<typeof vi.fn>;
  let readTextSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetSingletonForTests();
    writeSpy.mockClear();
    terminalCtor.mockClear();
    eventSpy.mockClear();
    keyHandlerRef.current = null;
    inputSpy = vi.fn();
    saveImageSpy = vi.fn(async () => null); // no image by default
    readTextSpy = vi.fn(() => 'pasted-text');
    (window as unknown as { ccsmPty: unknown }).ccsmPty = {
      input: inputSpy,
      saveClipboardImage: saveImageSpy,
      clipboard: { writeText: vi.fn(), readText: readTextSpy },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    ensureTerminal(host as HTMLDivElement);
    setActiveSid('sid-paste');
  });

  afterEach(() => {
    __resetSingletonForTests();
    document.body.innerHTML = '';
    setActiveSid(null);
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
  });

  it('capture-DOM paste fires paste.branch with branch="capture-dom"', async () => {
    const e = new Event('paste', { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: () => 'hello-clip' },
    });
    host.dispatchEvent(e);
    // pasteIntoActivePty is async — wait a tick for the saveClipboardImage promise.
    await new Promise((r) => setTimeout(r, 0));
    const branches = fieldsFor('paste.branch').map((f) => f.branch);
    expect(branches).toContain('capture-dom');
    expect(branches).toContain('text'); // inner image-vs-text branch
  });

  it('Ctrl+V keyboard paste fires paste.branch with branch="ctrl-v"', async () => {
    expect(keyHandlerRef.current).toBeTypeOf('function');
    const ev = {
      type: 'keydown',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: 'v',
    } as unknown as KeyboardEvent;
    keyHandlerRef.current!(ev);
    await new Promise((r) => setTimeout(r, 0));
    const branches = fieldsFor('paste.branch').map((f) => f.branch);
    expect(branches).toContain('ctrl-v');
  });

  it('right-click terminalPaste fires paste.branch with branch="right-click"', async () => {
    terminalPaste();
    await new Promise((r) => setTimeout(r, 0));
    const branches = fieldsFor('paste.branch').map((f) => f.branch);
    expect(branches).toContain('right-click');
  });

  it('image-branch paste fires paste.branch with branch="image" instead of "text"', async () => {
    saveImageSpy.mockResolvedValueOnce('C:\\tmp\\img.png');
    terminalPaste();
    await new Promise((r) => setTimeout(r, 0));
    const branches = fieldsFor('paste.branch').map((f) => f.branch);
    expect(branches).toContain('image');
    expect(branches).not.toContain('text');
  });

  it('paste.normalized reports byte counts + crlfFound, no content', async () => {
    readTextSpy.mockReturnValueOnce('line1\r\nline2\r\nline3');
    terminalPaste();
    await new Promise((r) => setTimeout(r, 0));
    const norm = fieldsFor('paste.normalized')[0];
    expect(norm).toBeDefined();
    expect(norm.crlfFound).toBe(true);
    expect(norm.bytesBefore).toBe('line1\r\nline2\r\nline3'.length);
    expect(norm.bytesAfter).toBe('line1\nline2\nline3'.length);
    // Critical: no content field leaks.
    expect(norm).not.toHaveProperty('text');
    expect(norm).not.toHaveProperty('content');
    expect(norm).not.toHaveProperty('data');
  });

  it('paste.hop stages cover capture → prepare → ipc-send → pty-write', async () => {
    terminalPaste();
    await new Promise((r) => setTimeout(r, 0));
    const stages = fieldsFor('paste.hop').map((f) => f.stage);
    expect(stages).toContain('capture');
    expect(stages).toContain('prepare');
    expect(stages).toContain('ipc-send');
    expect(stages).toContain('pty-write');
  });

  it('every paste event carries the snapshotted sid (no leaks)', async () => {
    terminalPaste();
    await new Promise((r) => setTimeout(r, 0));
    for (const call of eventSpy.mock.calls) {
      const name = call[0] as string;
      if (!name.startsWith('paste.')) continue;
      const fields = (call[1] ?? {}) as Record<string, unknown>;
      expect(fields.sid).toBe('sid-paste');
      // No content-shaped fields anywhere.
      for (const forbidden of ['text', 'content', 'data', 'clipboard', 'composition', 'payload']) {
        expect(fields).not.toHaveProperty(forbidden);
      }
    }
  });

  it('does nothing (no events) when activeSid is null', async () => {
    setActiveSid(null);
    eventSpy.mockClear();
    terminalPaste();
    await new Promise((r) => setTimeout(r, 0));
    // pasteIntoActivePty early-returns; the `paste.branch` at the entry
    // point is also gated on activeSid, so zero events fire.
    expect(eventSpy.mock.calls.length).toBe(0);
  });
});
