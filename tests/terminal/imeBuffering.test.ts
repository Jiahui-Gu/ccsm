import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock xterm constructors BEFORE importing the module under test. The
// mock Terminal exposes a real <textarea> so the singleton's
// compositionstart/compositionend listeners (attached to `term.textarea`
// inside `ensureTerminal`) can be exercised with real DOM events. The
// `write` method is a plain spy so we can assert it (was not) called at
// the right moments.
const { writeSpy, textarea, terminalCtor } = vi.hoisted(() => {
  const writeSpy = vi.fn();
  const textarea = (globalThis as unknown as { document: Document }).document.createElement('textarea');
  const terminalCtor = vi.fn(function () {
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      onSelectionChange: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
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
  return { writeSpy, textarea, terminalCtor };
});

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

import {
  __resetSingletonForTests,
  ensureTerminal,
  writeOrBuffer,
} from '../../src/terminal/xtermSingleton';

describe('writeOrBuffer — IME composition buffering', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    writeSpy.mockClear();
    terminalCtor.mockClear();
    // Fresh host each test so ensureTerminal's open() side-effects don't bleed.
    const host = document.createElement('div');
    document.body.appendChild(host);
    ensureTerminal(host as HTMLDivElement);
  });

  afterEach(() => {
    __resetSingletonForTests();
    document.body.innerHTML = '';
  });

  it('writes immediately when not composing', () => {
    writeOrBuffer('hello');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('hello');
  });

  it('buffers chunks while composing (no term.write calls)', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    writeOrBuffer('a');
    writeOrBuffer('b');
    writeOrBuffer('c');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('flushes the buffered chunks in a single write on compositionend', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    writeOrBuffer('foo');
    writeOrBuffer('bar');
    writeOrBuffer('baz');
    expect(writeSpy).not.toHaveBeenCalled();

    textarea.dispatchEvent(new CompositionEvent('compositionend'));
    // One coalesced flush of the accumulated buffer.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('foobarbaz');
  });

  it('clears the buffer after flush so subsequent writes go direct', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    writeOrBuffer('queued');
    textarea.dispatchEvent(new CompositionEvent('compositionend'));
    writeSpy.mockClear();

    writeOrBuffer('after');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('after');
  });

  it('compositionend with no buffered chunks does not call write', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    textarea.dispatchEvent(new CompositionEvent('compositionend'));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('a fresh compositionstart re-engages buffering after a prior cycle', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    writeOrBuffer('x');
    textarea.dispatchEvent(new CompositionEvent('compositionend'));
    writeSpy.mockClear();

    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    writeOrBuffer('y');
    expect(writeSpy).not.toHaveBeenCalled();
    textarea.dispatchEvent(new CompositionEvent('compositionend'));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('y');
  });
});
