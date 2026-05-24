// IME composition buffering via the warm registry (`xtermWarmRegistry.ts`).
//
// While a CJK IME is composing, the `pty.onData` live-mode handler must
// buffer chunks rather than calling `term.write` directly — each write
// reanchors the hidden textarea and makes the composition preview jump.
// On `compositionend` the buffered chunks flush in a single coalesced
// write.
//
// This test drives the registry's `allocEntry` → `ensureAndShowEntry`
// pipeline with a real DOM textarea so the compositionstart/end
// listeners attach against it (they're installed inside
// `ensureAndShowEntry` after `term.open()` makes the textarea real).
// The `pty.onData` callback captured at alloc time is invoked directly
// to simulate live chunks; we assert that writes during the composition
// window are buffered, and that they all land on `compositionend`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { writeSpy, textareaRef, terminalCtor } = vi.hoisted(() => {
  const writeSpy = vi.fn();
  const textareaRef: { current: HTMLTextAreaElement } = {
    current: (globalThis as unknown as { document: Document }).document.createElement('textarea'),
  };
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
      attachCustomKeyEventHandler: vi.fn(),
      getSelection: vi.fn(() => ''),
      clearSelection: vi.fn(),
      selectAll: vi.fn(),
      resize: vi.fn(),
      cols: 80,
      rows: 24,
      unicode: { activeVersion: '6' },
      modes: { bracketedPasteMode: false },
      buffer: {
        active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0, type: 'normal' },
      },
      textarea: textareaRef.current,
      write: writeSpy,
    };
  });
  return { writeSpy, textareaRef, terminalCtor };
});

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

// Capture the onData callback the registry installs so we can fire live
// chunks at will.
let onDataCb: ((p: { sid: string; chunk: string; seq: number }) => void) | null = null;
function installFakeBridge(): void {
  onDataCb = null;
  (window as unknown as { ccsmPty: unknown }).ccsmPty = {
    onData: (cb: typeof onDataCb) => {
      onDataCb = cb;
      return () => {
        onDataCb = null;
      };
    },
    onExit: () => () => {},
  };
}

import {
  __resetRegistryForTests,
  applySnapshot,
  ensureAndShowEntry,
} from '../../src/terminal/xtermWarmRegistry';

describe('warm registry — IME composition buffering', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    __resetRegistryForTests();
    writeSpy.mockClear();
    terminalCtor.mockClear();
    installFakeBridge();
    host = document.createElement('div');
    document.body.appendChild(host);
    // ensureAndShowEntry → allocEntry + term.open + install IME listeners.
    ensureAndShowEntry('sid-1', host, 'mount');
    // Flip router to 'live' so subsequent onData writes go through the
    // composition guard (router buffers otherwise).
    applySnapshot('sid-1', 0);
  });

  afterEach(() => {
    __resetRegistryForTests();
    document.body.innerHTML = '';
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
  });

  function fireChunk(chunk: string, seq: number): void {
    onDataCb?.({ sid: 'sid-1', chunk, seq });
  }

  it('writes immediately when not composing', () => {
    fireChunk('hello', 1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenLastCalledWith('hello');
  });

  it('buffers chunks while composing (no term.write calls)', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    fireChunk('a', 1);
    fireChunk('b', 2);
    fireChunk('c', 3);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('flushes the buffered chunks in a single write on compositionend', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    fireChunk('foo', 1);
    fireChunk('bar', 2);
    fireChunk('baz', 3);
    expect(writeSpy).not.toHaveBeenCalled();

    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenLastCalledWith('foobarbaz');
  });

  it('clears the buffer after flush so subsequent writes go direct', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    fireChunk('queued', 1);
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    writeSpy.mockClear();

    fireChunk('after', 2);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenLastCalledWith('after');
  });

  it('compositionend with no buffered chunks does not call write', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('a fresh compositionstart re-engages buffering after a prior cycle', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    fireChunk('x', 1);
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    writeSpy.mockClear();

    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    fireChunk('y', 2);
    expect(writeSpy).not.toHaveBeenCalled();
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenLastCalledWith('y');
  });
});
