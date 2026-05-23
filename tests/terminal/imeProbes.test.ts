// PR B Stage 2 — IME composition probes.
//
// Verifies the structured `log.event` calls emitted by the compositionstart /
// compositionupdate / compositionend listeners in `xtermSingleton.ts`.
// Particularly: `ime.composition.progress` is sampled every 10th update so
// long pinyin sessions don't flood the log. The 1st-through-9th, 11th-
// through-19th, etc. updates must NOT fire `progress`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same hoisted-ctor pattern as imeBuffering.test.ts so the singleton wires
// real DOM compositionstart/update/end listeners to a real <textarea>.
const { writeSpy, textareaRef, terminalCtor } = vi.hoisted(() => {
  const writeSpy = vi.fn();
  const textareaRef: { current: HTMLTextAreaElement } = {
    current: (globalThis as unknown as { document: Document }).document.createElement('textarea'),
  };
  const terminalCtor = vi.fn(function () {
    // Fresh textarea per Terminal so leftover listeners from a prior test
    // don't double-fire compositionupdate handlers on subsequent tests.
    textareaRef.current = (globalThis as unknown as { document: Document }).document.createElement('textarea');
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

// Mock the shared log so we can assert on `log.event(...)` payloads without
// the real electron-log path firing. We keep `warn` (and `error`) as real
// no-op spies so the back-compat shim used inside xtermSingleton for addon-
// load failures doesn't blow up.
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
  writeOrBuffer,
} from '../../src/terminal/xtermSingleton';

function eventNames(): string[] {
  return eventSpy.mock.calls.map((c) => c[0] as string);
}

function fieldsFor(name: string): Array<Record<string, unknown>> {
  return eventSpy.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

describe('IME probes — composition lifecycle events', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    writeSpy.mockClear();
    terminalCtor.mockClear();
    eventSpy.mockClear();
    const host = document.createElement('div');
    document.body.appendChild(host);
    ensureTerminal(host as HTMLDivElement);
    setActiveSid('sid-1');
  });

  afterEach(() => {
    __resetSingletonForTests();
    document.body.innerHTML = '';
    setActiveSid(null);
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
    // Only sid + integer count.
    expect(Object.keys(fields).sort()).toEqual(['count', 'sid']);
  });

  it('resets update counter on a fresh compositionstart', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 5; i++) {
      textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate'));
    }
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionend'));
    eventSpy.mockClear();

    // Second composition: only 5 updates → still no progress event.
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    for (let i = 0; i < 5; i++) {
      textareaRef.current.dispatchEvent(new CompositionEvent('compositionupdate'));
    }
    expect(eventNames()).not.toContain('ime.composition.progress');
  });

  it('fires composition.end with bufferedChunks/bufferedBytes from writeOrBuffer', () => {
    textareaRef.current.dispatchEvent(new CompositionEvent('compositionstart'));
    writeOrBuffer('abc'); // 3 bytes, 1 chunk
    writeOrBuffer('de'); // 2 bytes, 2 chunks total
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
    writeOrBuffer('xyz');
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
