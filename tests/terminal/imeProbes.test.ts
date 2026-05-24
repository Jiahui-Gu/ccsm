// IME composition probes — `ime.composition.start/progress/end` +
// `ime.buffer.flush`. These fire from the listeners installed by the warm
// registry's `installInputListeners` (after `term.open()` makes the
// textarea real). `progress` is sampled every 10th update so a long
// pinyin session doesn't flood the log.

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
      buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0, type: 'normal' } },
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

function eventNames(): string[] {
  return eventSpy.mock.calls.map((c) => c[0] as string);
}

function fieldsFor(name: string): Array<Record<string, unknown>> {
  return eventSpy.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

describe('IME probes — composition lifecycle events (warm registry)', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    __resetRegistryForTests();
    writeSpy.mockClear();
    terminalCtor.mockClear();
    eventSpy.mockClear();
    installFakeBridge();
    host = document.createElement('div');
    document.body.appendChild(host);
    ensureAndShowEntry('sid-1', host, 'mount');
    applySnapshot('sid-1', 0);
    // Clear the warmAlloc + warmShow events fired during setup so the
    // per-test assertions count only composition events.
    eventSpy.mockClear();
  });

  afterEach(() => {
    __resetRegistryForTests();
    document.body.innerHTML = '';
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
  });

  it('fires ime.composition.start on compositionstart', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(eventNames()).toContain('ime.composition.start');
    expect(fieldsFor('ime.composition.start')[0]).toMatchObject({ sid: 'sid-1' });
  });

  it('does NOT fire progress for updates 1..9', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 9; i++) {
      textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate'));
    }
    expect(eventNames()).not.toContain('ime.composition.progress');
  });

  it('fires progress on the 10th update with count=10', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 10; i++) {
      textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate'));
    }
    const progress = fieldsFor('ime.composition.progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ sid: 'sid-1', count: 10 });
  });

  it('does NOT fire progress for updates 11..19, fires again at 20', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 19; i++) {
      textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate'));
    }
    expect(fieldsFor('ime.composition.progress')).toHaveLength(1); // only at 10
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate')); // 20th
    const progress = fieldsFor('ime.composition.progress');
    expect(progress).toHaveLength(2);
    expect(progress[1]).toMatchObject({ count: 20 });
  });

  it('progress payload contains NO content/data fields', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 10; i++) {
      textareaRef.current.dispatchEvent(
        new CompositionEvent('compositionupdate', { data: 'secret-pinyin' }),
      );
    }
    const fields = fieldsFor('ime.composition.progress')[0];
    expect(fields).not.toHaveProperty('data');
    expect(fields).not.toHaveProperty('content');
    expect(fields).not.toHaveProperty('text');
    expect(fields).not.toHaveProperty('composition');
    expect(Object.keys(fields).sort()).toEqual(['count', 'sid']);
  });

  it('resets update counter on a fresh compositionstart', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 5; i++) {
      textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate'));
    }
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    eventSpy.mockClear();

    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 5; i++) {
      textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate'));
    }
    expect(eventNames()).not.toContain('ime.composition.progress');
  });

  it('fires composition.end with bufferedChunks/bufferedBytes from live PTY chunks', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    onDataCb?.({ sid: 'sid-1', chunk: 'abc', seq: 1 }); // 3 bytes, 1 chunk
    onDataCb?.({ sid: 'sid-1', chunk: 'de', seq: 2 }); // +2 bytes, 2 chunks total
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    const end = fieldsFor('ime.composition.end')[0];
    expect(end).toMatchObject({
      sid: 'sid-1',
      bufferedChunks: 2,
      bufferedBytes: 5,
    });
    expect(typeof end.durationMs).toBe('number');
  });

  it('fires ime.buffer.flush when end drains a non-empty buffer', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    onDataCb?.({ sid: 'sid-1', chunk: 'xyz', seq: 1 });
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    const flush = fieldsFor('ime.buffer.flush')[0];
    expect(flush).toMatchObject({ sid: 'sid-1', bytes: 3, chunks: 1 });
  });

  it('does NOT fire ime.buffer.flush when buffer is empty at end', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    expect(eventNames()).not.toContain('ime.buffer.flush');
  });
});
