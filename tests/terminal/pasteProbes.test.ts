// Paste probe events — `paste.branch`, `paste.normalized`, `paste.hop`
// fire with the expected entry-point tags and metadata. Exercises three
// paste entry points:
//
//   - Capture-DOM listener: registered on the entry's wrapper by the
//     warm registry's `installInputListeners`. We dispatch a `paste`
//     ClipboardEvent on the wrapper.
//
//   - Ctrl/Cmd+V keyboard: routed through the custom key event handler
//     the registry installs. We grab the handler off the mocked
//     `attachCustomKeyEventHandler` and invoke it directly.
//
//   - Right-click: routed through `paste.ts#terminalPaste`, which
//     TerminalPane's onContextMenu calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { writeSpy, textareaRef, keyHandlerRef, terminalCtor } = vi.hoisted(() => {
  const writeSpy = vi.fn();
  const textareaRef: { current: HTMLTextAreaElement } = {
    current: (globalThis as unknown as { document: Document }).document.createElement('textarea'),
  };
  const keyHandlerRef: { current: ((ev: KeyboardEvent) => boolean) | null } = { current: null };
  const terminalCtor = vi.fn(function () {
    textareaRef.current = (globalThis as unknown as { document: Document }).document.createElement(
      'textarea',
    );
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      reset: vi.fn(),
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn((cb: (ev: KeyboardEvent) => boolean) => {
        keyHandlerRef.current = cb;
      }),
      getSelection: vi.fn(() => ''),
      clearSelection: vi.fn(),
      selectAll: vi.fn(),
      resize: vi.fn(),
      cols: 80,
      rows: 24,
      unicode: { activeVersion: '6' },
      modes: { bracketedPasteMode: false },
      buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0, type: 'normal' } },
      textarea: textareaRef.current,
      write: writeSpy,
    };
  });
  return { writeSpy, textareaRef, keyHandlerRef, terminalCtor };
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

function installFakeBridge(opts: {
  saveImage?: () => Promise<string | null>;
  readText?: () => string;
}): { inputSpy: ReturnType<typeof vi.fn> } {
  const inputSpy = vi.fn();
  (window as unknown as { ccsmPty: unknown }).ccsmPty = {
    onData: () => () => {},
    onExit: () => () => {},
    input: inputSpy,
    saveClipboardImage: opts.saveImage ?? (async () => null),
    clipboard: { writeText: vi.fn(), readText: opts.readText ?? (() => 'pasted-text') },
  };
  return { inputSpy };
}

import {
  __resetRegistryForTests,
  ensureAndShowEntry,
  getActiveEntry,
} from '../../src/terminal/xtermWarmRegistry';
import { terminalPaste } from '../../src/terminal/paste';

function fieldsFor(name: string): Array<Record<string, unknown>> {
  return eventSpy.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

describe('paste probes — entry-point branch dispatch (warm path)', () => {
  let host: HTMLDivElement;
  let inputSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetRegistryForTests();
    writeSpy.mockClear();
    terminalCtor.mockClear();
    eventSpy.mockClear();
    keyHandlerRef.current = null;
    ({ inputSpy } = installFakeBridge({}));
    host = document.createElement('div');
    document.body.appendChild(host);
    ensureAndShowEntry('sid-paste', host, 'mount');
    eventSpy.mockClear();
  });

  afterEach(() => {
    __resetRegistryForTests();
    document.body.innerHTML = '';
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
  });

  it('capture-DOM paste fires paste.branch with branch="capture-dom"', async () => {
    const wrapper = host.querySelector('[data-ccsm-warm-sid="sid-paste"]') as HTMLDivElement;
    expect(wrapper).toBeTruthy();
    const e = new Event('paste', { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: () => 'hello-clip' },
    });
    wrapper.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 0));
    const branches = fieldsFor('paste.branch').map((f) => f.branch);
    expect(branches).toContain('capture-dom');
    expect(branches).toContain('text');
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
    await terminalPaste(() => getActiveEntry()?.term, 'sid-paste', 'right-click');
    const branches = fieldsFor('paste.branch').map((f) => f.branch);
    expect(branches).toContain('right-click');
  });

  it('image-branch paste fires paste.branch with branch="image" instead of "text"', async () => {
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    installFakeBridge({ saveImage: async () => 'C:\\tmp\\img.png' });
    await terminalPaste(() => getActiveEntry()?.term, 'sid-paste', 'right-click');
    const branches = fieldsFor('paste.branch').map((f) => f.branch);
    expect(branches).toContain('image');
    expect(branches).not.toContain('text');
  });

  it('paste.normalized reports byte counts + crlfFound, no content', async () => {
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    installFakeBridge({ readText: () => 'line1\r\nline2\r\nline3' });
    await terminalPaste(() => getActiveEntry()?.term, 'sid-paste', 'right-click');
    const norm = fieldsFor('paste.normalized')[0];
    expect(norm).toBeDefined();
    expect(norm.crlfFound).toBe(true);
    expect(norm.bytesBefore).toBe('line1\r\nline2\r\nline3'.length);
    expect(norm.bytesAfter).toBe('line1\nline2\nline3'.length);
    expect(norm).not.toHaveProperty('text');
    expect(norm).not.toHaveProperty('content');
    expect(norm).not.toHaveProperty('data');
  });

  it('paste.hop stages cover capture → prepare → ipc-send → pty-write', async () => {
    await terminalPaste(() => getActiveEntry()?.term, 'sid-paste', 'right-click');
    const stages = fieldsFor('paste.hop').map((f) => f.stage);
    expect(stages).toContain('capture');
    expect(stages).toContain('prepare');
    expect(stages).toContain('ipc-send');
    expect(stages).toContain('pty-write');
  });

  it('every paste event carries the snapshotted sid (no leaks)', async () => {
    await terminalPaste(() => getActiveEntry()?.term, 'sid-paste', 'right-click');
    for (const call of eventSpy.mock.calls) {
      const name = call[0] as string;
      if (!name.startsWith('paste.')) continue;
      const fields = (call[1] ?? {}) as Record<string, unknown>;
      expect(fields.sid).toBe('sid-paste');
      for (const forbidden of ['text', 'content', 'data', 'clipboard', 'composition', 'payload']) {
        expect(fields).not.toHaveProperty(forbidden);
      }
    }
  });

  it('ccsmPty.input receives the bracketed, LF-normalized payload exactly once', async () => {
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    const { inputSpy: spy } = installFakeBridge({ readText: () => 'a\r\nb\r\nc' });
    await terminalPaste(() => getActiveEntry()?.term, 'sid-paste', 'right-click');
    expect(spy).toHaveBeenCalledTimes(1);
    // bracketedPasteMode is false in the mocked term, so no wrap.
    expect(spy).toHaveBeenCalledWith('sid-paste', 'a\nb\nc');
  });
});
