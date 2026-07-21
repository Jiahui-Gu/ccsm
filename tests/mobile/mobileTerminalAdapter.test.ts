// TDD unit tests for `createMobileTerminalAdapter` using injected terminal
// and addon factories (never `vi.mock('@xterm/xterm')`) per the mobile
// composer/terminal-sync plan's Task 4 and the final interaction contract:
// the adapter is read/scroll/select/copy only and must never call
// `terminal.focus()` / `terminal.blur()` or register `terminal.onData`.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

import {
  createMobileTerminalAdapter,
  type MobileFitAddon,
  type MobileSerializeAddon,
  type MobileTerminalAdapter,
  type MobileTerminalAdapterOptions,
  type MobileTerminalDimensions,
  type MobileXtermAddon,
} from '../../src/mobile/mobileTerminalAdapter';
import type { ITerminalOptions } from '@xterm/xterm';

// A structural fake of xterm's public `Terminal` API, plus two probes
// (`focus`, `onData`) that are NOT part of the adapter's declared
// dependency surface — they exist purely so tests can assert the adapter
// never touches them.
function createFakeTerminal() {
  const element = document.createElement('div');
  const textarea = document.createElement('textarea');
  element.appendChild(textarea);
  return {
    element,
    textarea,
    cols: 80,
    rows: 24,
    unicode: { activeVersion: '6' },
    open: vi.fn((parent: HTMLElement) => parent.appendChild(element)),
    reset: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    getSelection: vi.fn(() => ''),
    clearSelection: vi.fn(),
    loadAddon: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    onData: vi.fn(),
  };
}

function createFakeAddon(): MobileXtermAddon & { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn() };
}

function createFakeFitAddon(): MobileFitAddon & {
  dispose: ReturnType<typeof vi.fn>;
  proposeDimensions: ReturnType<typeof vi.fn>;
} {
  return {
    dispose: vi.fn(),
    proposeDimensions: vi.fn<() => MobileTerminalDimensions | undefined>(() => undefined),
  };
}

function createFakeSerializeAddon(): MobileSerializeAddon & {
  dispose: ReturnType<typeof vi.fn>;
  serialize: ReturnType<typeof vi.fn>;
} {
  return { dispose: vi.fn(), serialize: vi.fn(() => 'serialized-output') };
}

type Harness = {
  adapter: MobileTerminalAdapter;
  terminal: ReturnType<typeof createFakeTerminal>;
  fit: ReturnType<typeof createFakeFitAddon>;
  serialize: ReturnType<typeof createFakeSerializeAddon>;
  unicode11: ReturnType<typeof createFakeAddon>;
  webLinks: ReturnType<typeof createFakeAddon>;
  createTerminalSpy: ReturnType<typeof vi.fn>;
  host: HTMLDivElement;
};

const createdAdapters: MobileTerminalAdapter[] = [];

function createHarness(
  overrides: Partial<MobileTerminalAdapterOptions> = {},
): Harness {
  const host = document.createElement('div');
  const terminal = createFakeTerminal();
  const fit = createFakeFitAddon();
  const serialize = createFakeSerializeAddon();
  const unicode11 = createFakeAddon();
  const webLinks = createFakeAddon();
  const createTerminalSpy = vi.fn((_options: ITerminalOptions) => terminal);

  const adapter = createMobileTerminalAdapter(host, {
    createTerminal: createTerminalSpy,
    createFitAddon: () => fit,
    createSerializeAddon: () => serialize,
    createUnicode11Addon: () => unicode11,
    createWebLinksAddon: () => webLinks,
    ...overrides,
  });
  createdAdapters.push(adapter);

  return { adapter, terminal, fit, serialize, unicode11, webLinks, createTerminalSpy, host };
}

describe('createMobileTerminalAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const adapter of createdAdapters.splice(0)) {
      try {
        adapter.dispose();
      } catch {
        /* already disposed by the test */
      }
    }
    vi.useRealTimers();
  });

  it('constructs exactly one stable read-only terminal with the required options', () => {
    const { createTerminalSpy } = createHarness();
    expect(createTerminalSpy).toHaveBeenCalledOnce();
    expect(createTerminalSpy.mock.calls[0]?.[0]).toMatchObject({
      convertEol: false,
      disableStdin: true,
      cursorBlink: false,
      fontFamily:
        'JetBrains Mono Variable, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: { background: '#0d0f12', foreground: '#e8eaed' },
    });
  });

  it('loads exactly FitAddon, SerializeAddon, Unicode11Addon, WebLinksAddon and activates unicode 11 — no CanvasAddon', () => {
    const { terminal, fit, serialize, unicode11, webLinks } = createHarness();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(4);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(1, fit);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(2, serialize);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(3, unicode11);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(4, webLinks);
    expect(terminal.unicode.activeVersion).toBe('11');
  });

  it('never registers terminal.onData', () => {
    const { terminal } = createHarness();
    expect(terminal.onData).not.toHaveBeenCalled();
    // The adapter must not have wired onData at all — the mock must remain
    // completely untouched, not merely uncalled by user action.
    expect(terminal.onData.mock.calls.length).toBe(0);
  });

  it('hardens the helper textarea without ever calling focus()/blur()', () => {
    const { terminal } = createHarness();
    expect(terminal.textarea.readOnly).toBe(true);
    expect(terminal.textarea.tabIndex).toBe(-1);
    expect(terminal.textarea.getAttribute('inputmode')).toBe('none');
    expect(terminal.textarea.getAttribute('aria-hidden')).toBe('true');
    expect(terminal.focus).not.toHaveBeenCalled();
    // Pointer events must stay usable for native selection/copy.
    expect(terminal.textarea.style.pointerEvents).not.toBe('none');
    expect(terminal.element.style.pointerEvents).not.toBe('none');
  });

  it('never focuses the xterm textarea on pointer interaction', () => {
    const { adapter, terminal } = createHarness();
    terminal.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    terminal.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(terminal.focus).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('applies writes incrementally and snapshots as reset plus write, in order', () => {
    const { adapter, terminal } = createHarness();
    adapter.apply([{ type: 'write', data: 'tail' }]);
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledWith('tail');

    adapter.apply([{ type: 'reset', data: 'screen' }]);
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenLastCalledWith('screen');

    terminal.write.mockClear();
    terminal.reset.mockClear();
    adapter.apply([
      { type: 'reset', data: 'a' },
      { type: 'write', data: 'b' },
      { type: 'write', data: 'c' },
    ]);
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c']);
  });

  it('ignores requestSnapshot effects (no terminal action)', () => {
    const { adapter, terminal } = createHarness();
    adapter.apply([{ type: 'requestSnapshot', sid: 'sid-1' }]);
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('serialize() delegates to SerializeAddon.serialize()', () => {
    const { adapter, serialize } = createHarness();
    expect(adapter.serialize()).toBe('serialized-output');
    expect(serialize.serialize).toHaveBeenCalledOnce();
  });

  describe('copySelection', () => {
    const originalClipboard = navigator.clipboard;

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
      });
    });

    it('is a no-op when there is no selection', async () => {
      const { adapter, terminal } = createHarness();
      terminal.getSelection.mockReturnValue('');
      const writeText = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      await adapter.copySelection();

      expect(writeText).not.toHaveBeenCalled();
      expect(terminal.clearSelection).not.toHaveBeenCalled();
    });

    it('writes the selection to the clipboard then clears it on success', async () => {
      const { adapter, terminal } = createHarness();
      terminal.getSelection.mockReturnValue('hello world');
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      await adapter.copySelection();

      expect(writeText).toHaveBeenCalledWith('hello world');
      expect(terminal.clearSelection).toHaveBeenCalledOnce();
    });

    it('preserves the selection and surfaces the rejection when the write fails', async () => {
      const { adapter, terminal } = createHarness();
      terminal.getSelection.mockReturnValue('hello world');
      const failure = new Error('clipboard denied');
      const writeText = vi.fn().mockRejectedValue(failure);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      await expect(adapter.copySelection()).rejects.toThrow('clipboard denied');

      expect(terminal.clearSelection).not.toHaveBeenCalled();
    });
  });

  describe('fit()', () => {
    it('validates finite dimensions >= 2 before resizing', () => {
      const { adapter, terminal, fit } = createHarness();

      fit.proposeDimensions.mockReturnValue(undefined);
      adapter.fit();
      expect(terminal.resize).not.toHaveBeenCalled();

      fit.proposeDimensions.mockReturnValue({ cols: 1, rows: 24 });
      adapter.fit();
      expect(terminal.resize).not.toHaveBeenCalled();

      fit.proposeDimensions.mockReturnValue({ cols: Number.NaN, rows: 24 });
      adapter.fit();
      expect(terminal.resize).not.toHaveBeenCalled();

      fit.proposeDimensions.mockReturnValue({ cols: Number.POSITIVE_INFINITY, rows: 24 });
      adapter.fit();
      expect(terminal.resize).not.toHaveBeenCalled();

      fit.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
      adapter.fit();
      expect(terminal.resize).toHaveBeenCalledWith(80, 24);
    });

    it('computes immediately (no debounce) for a direct call', () => {
      const { adapter, terminal, fit } = createHarness();
      fit.proposeDimensions.mockReturnValue({ cols: 100, rows: 40 });
      adapter.fit();
      expect(terminal.resize).toHaveBeenCalledWith(100, 40);
    });

    it('deduplicates resize emissions for unchanged dimensions', () => {
      const onResize = vi.fn();
      const { adapter, fit } = createHarness({ onResize });
      fit.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
      adapter.fit();
      adapter.fit();
      expect(onResize).toHaveBeenCalledOnce();
      expect(onResize).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    });

    it('emits onResize again for changed dimensions', () => {
      const onResize = vi.fn();
      const { adapter, fit } = createHarness({ onResize });
      fit.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
      adapter.fit();
      fit.proposeDimensions.mockReturnValue({ cols: 90, rows: 30 });
      adapter.fit();
      expect(onResize).toHaveBeenCalledTimes(2);
    });

    it('force re-emits onResize even for unchanged dimensions', () => {
      const onResize = vi.fn();
      const { adapter, fit } = createHarness({ onResize });
      fit.proposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
      adapter.fit();
      adapter.fit(true);
      expect(onResize).toHaveBeenCalledTimes(2);
    });
  });

  describe('viewport scheduling', () => {
    it('debounces window resize events by 120ms', () => {
      const { terminal, fit } = createHarness();
      fit.proposeDimensions.mockReturnValue({ cols: 100, rows: 40 });
      terminal.resize.mockClear();

      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(119);
      expect(terminal.resize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(terminal.resize).toHaveBeenCalledTimes(1);
    });

    it('follows up an orientationchange after 250ms', () => {
      const { terminal, fit } = createHarness();
      fit.proposeDimensions.mockReturnValue({ cols: 100, rows: 40 });
      terminal.resize.mockClear();

      window.dispatchEvent(new Event('orientationchange'));
      vi.advanceTimersByTime(120);
      expect(terminal.resize).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(249);
      expect(terminal.resize).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      // 250ms follow-up rearms the 120ms debounce.
      vi.advanceTimersByTime(120);
      expect(terminal.resize).toHaveBeenCalledTimes(2);
    });
  });

  describe('dispose', () => {
    it('disposes the terminal and every addon exactly once, even if called twice', () => {
      const { adapter, terminal, fit, serialize, unicode11, webLinks } = createHarness();
      adapter.dispose();
      adapter.dispose();
      expect(terminal.dispose).toHaveBeenCalledOnce();
      expect(fit.dispose).toHaveBeenCalledOnce();
      expect(serialize.dispose).toHaveBeenCalledOnce();
      expect(unicode11.dispose).toHaveBeenCalledOnce();
      expect(webLinks.dispose).toHaveBeenCalledOnce();
    });

    it('removes window/visualViewport listeners and clears timers on dispose', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
      const { adapter } = createHarness();
      adapter.dispose();
      const removedTypes = removeEventListenerSpy.mock.calls.map((call) => call[0]);
      expect(removedTypes).toContain('resize');
      expect(removedTypes).toContain('orientationchange');
      removeEventListenerSpy.mockRestore();
    });

    it('a disposed adapter no longer resizes on a subsequent debounced fit', () => {
      const { adapter, terminal, fit } = createHarness();
      fit.proposeDimensions.mockReturnValue({ cols: 100, rows: 40 });
      adapter.dispose();
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(200);
      expect(terminal.resize).not.toHaveBeenCalled();
    });
  });
});

// Regression coverage for Task 4 review finding C1: a real `@xterm/xterm`
// `Terminal`'s internal core registers its OWN "mousedown" listener on
// `terminal.element` (xterm.js `bindMouse()`) that calls the core's private
// `focus()` method directly on `this.textarea` — completely bypassing the
// public `Terminal.prototype.focus` API. Fake-terminal tests above (and the
// public-`focus`-spying tests elsewhere) cannot see this: they either don't
// exercise a real Terminal, or they spy on the wrong (public) method, or
// they dispatch synthetic pointer/click events that xterm's mousedown
// listener never receives. This suite opens a REAL Terminal through the
// production `createMobileTerminalAdapter` entry point, captures it via a
// pass-through spy on `Terminal.prototype.open` (the only way to reach the
// live instance without unsafely mocking the module), and dispatches an
// actual native `mousedown` on `terminal.element`.
describe('real @xterm/xterm focus hardening (Task 4 finding C1)', () => {
  beforeAll(() => {
    const w = window as unknown as Record<string, unknown>;
    if (!w.matchMedia) {
      w.matchMedia = () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      });
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16)) as typeof window.requestAnimationFrame;
      window.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
    }
    if (typeof HTMLCanvasElement !== 'undefined') {
      const proto = HTMLCanvasElement.prototype as unknown as { getContext?: () => null };
      if (!proto.getContext) proto.getContext = () => null;
    }
  });

  function captureTerminalOnOpen(): { instance: () => Terminal | undefined; restore: () => void } {
    const originalOpen = Terminal.prototype.open;
    let captured: Terminal | undefined;
    const openSpy = vi
      .spyOn(Terminal.prototype, 'open')
      .mockImplementation(function (this: Terminal, parent: HTMLElement) {
        captured = this;
        return originalOpen.call(this, parent);
      });
    return {
      instance: () => captured,
      restore: () => openSpy.mockRestore(),
    };
  }

  it('never lets the real xterm core focus .xterm-helper-textarea on a native mousedown of terminal.element', async () => {
    const capture = captureTerminalOnOpen();
    // The prototype-level spy proves the browser's real focus algorithm
    // (which is what actually moves `document.activeElement`) is never
    // reached — an own-property override on the textarea instance would
    // shadow this entirely, which is exactly the hardening this test
    // demands.
    const protoFocusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const adapter = createMobileTerminalAdapter(host);

    const terminal = capture.instance();
    expect(terminal).toBeDefined();
    const textarea = terminal!.textarea as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.classList.contains('xterm-helper-textarea')).toBe(true);
    expect(document.activeElement).not.toBe(textarea);

    // Records whatever `focus` implementation is live on the textarea AT
    // THE TIME the real mousedown fires (production hardening already ran
    // inside `createMobileTerminalAdapter` above) — this is the "own focus
    // behavior" the finding asks to spy/record.
    const textareaFocusSpy = vi.spyOn(textarea, 'focus');

    terminal!.element!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
    );

    // xterm's internal mousedown handler does call `.focus()` on the helper
    // textarea (proving this test actually exercises the real code path)...
    expect(textareaFocusSpy).toHaveBeenCalled();
    // ...but the real/native focus implementation must never run, and focus
    // must never actually move onto the helper textarea.
    expect(protoFocusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(textarea);

    textareaFocusSpy.mockRestore();
    protoFocusSpy.mockRestore();
    capture.restore();
    adapter.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    host.remove();
  });
});
