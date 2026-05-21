import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock xterm constructors BEFORE importing the hook so the singleton
// uses the spies. Use vi.hoisted because vi.mock factories run before
// any top-level `const`.
const { openSpy, loadAddonSpy, onSelectionChangeSpy, attachCustomKeyEventHandlerSpy, getSelectionSpy, clearSelectionSpy, selectAllSpy, terminalCtor, webLinksCtor } =
  vi.hoisted(() => {
    const openSpy = vi.fn();
    const loadAddonSpy = vi.fn();
    const onSelectionChangeSpy = vi.fn();
    const attachCustomKeyEventHandlerSpy = vi.fn();
    const getSelectionSpy = vi.fn(() => '');
    const clearSelectionSpy = vi.fn();
    const selectAllSpy = vi.fn();
    // vitest v3+ requires `function`/`class` (not arrow) for mocks invoked
    // with `new` — otherwise tinyspy throws "is not a constructor".
    const terminalCtor = vi.fn(function () {
      return {
        open: openSpy,
        loadAddon: loadAddonSpy,
        onSelectionChange: onSelectionChangeSpy,
        attachCustomKeyEventHandler: attachCustomKeyEventHandlerSpy,
        getSelection: getSelectionSpy,
        clearSelection: clearSelectionSpy,
        selectAll: selectAllSpy,
        unicode: { activeVersion: '6' },
        _core: { _parent: null },
      };
    });
    const webLinksCtor = vi.fn(function () {
      return {};
    });
    return { openSpy, loadAddonSpy, onSelectionChangeSpy, attachCustomKeyEventHandlerSpy, getSelectionSpy, clearSelectionSpy, selectAllSpy, terminalCtor, webLinksCtor };
  });

vi.mock('@xterm/xterm', () => ({ Terminal: terminalCtor }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: webLinksCtor }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {}; }) }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn(function () { return {}; }) }));

import { useXtermSingleton } from '../../src/terminal/useXtermSingleton';
import {
  __resetSingletonForTests,
  getTerm,
  pasteIntoActivePty,
  setActiveSid,
  terminalCopy,
  terminalPaste,
} from '../../src/terminal/xtermSingleton';

describe('useXtermSingleton', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    terminalCtor.mockClear();
    openSpy.mockClear();
    loadAddonSpy.mockClear();
    webLinksCtor.mockClear();
  });

  afterEach(() => {
    __resetSingletonForTests();
  });

  it('creates the Terminal singleton on first mount', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(host);
    // Selection→clipboard wiring + custom key handler installed.
    expect(onSelectionChangeSpy).toHaveBeenCalledTimes(1);
    expect(attachCustomKeyEventHandlerSpy).toHaveBeenCalledTimes(1);
    // Probe handle exposed for e2e harness.
    expect(window.__ccsmTerm).toBe(getTerm());
  });

  // Wheel-scroll tuning regression guard. xterm's `Viewport.getLinesScrolled`
  // multiplies `event.deltaY` by `scrollSensitivity` before dividing by row
  // height; without these explicit values, a Windows precision-mouse notch
  // reporting `deltaY` ~120-400px lands the user 6-25 lines down per notch
  // ("light flick scrolls to middle of page"). A future refactor that drops
  // any of these three options silently resurrects the bug — pin them in a
  // test so the constructor contract is enforced.
  it('constructs Terminal with explicit wheel-scroll tuning', () => {
    const host = document.createElement('div');
    renderHook(() => useXtermSingleton({ current: host }));
    expect(terminalCtor).toHaveBeenCalledTimes(1);
    const opts = terminalCtor.mock.calls[0][0] as {
      scrollSensitivity?: number;
      fastScrollSensitivity?: number;
      fastScrollModifier?: string;
    };
    expect(opts.scrollSensitivity).toBe(0.5);
    expect(opts.fastScrollSensitivity).toBe(5);
    expect(opts.fastScrollModifier).toBe('alt');
  });

  it('reuses the singleton across remounts (does NOT recreate)', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    const r1 = renderHook(() => useXtermSingleton(ref));
    r1.unmount();
    const r2 = renderHook(() => useXtermSingleton(ref));
    r2.unmount();
    // ctor called exactly once across both mounts — proves cache hit.
    expect(terminalCtor).toHaveBeenCalledTimes(1);
  });

  it('no-ops when hostRef.current is null', () => {
    const ref = { current: null };
    renderHook(() => useXtermSingleton(ref));
    expect(terminalCtor).not.toHaveBeenCalled();
  });

  describe('WebLinksAddon Ctrl/Cmd-click handler', () => {
    // The handler is the first ctor arg to `new WebLinksAddon(handler)`.
    // We extract it from the mock to exercise the modifier-gate without
    // touching the live xterm DOM.
    function getHandler(): (ev: { ctrlKey?: boolean; metaKey?: boolean }, uri: string) => void {
      const host = document.createElement('div');
      renderHook(() => useXtermSingleton({ current: host }));
      expect(webLinksCtor).toHaveBeenCalledTimes(1);
      const handler = webLinksCtor.mock.calls[0][0];
      expect(typeof handler).toBe('function');
      return handler as (ev: { ctrlKey?: boolean; metaKey?: boolean }, uri: string) => void;
    }

    beforeEach(() => {
      // Install a fresh openExternal spy on window.ccsm for each case.
      (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } }).ccsm = {
        openExternal: vi.fn(),
      };
    });

    afterEach(() => {
      delete (window as unknown as { ccsm?: unknown }).ccsm;
    });

    it('opens external on Ctrl+click (Windows/Linux convention)', () => {
      const handler = getHandler();
      handler({ ctrlKey: true, metaKey: false }, 'https://example.com');
      const spy = (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } })
        .ccsm.openExternal;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('https://example.com');
    });

    it('opens external on Cmd+click (macOS convention)', () => {
      const handler = getHandler();
      handler({ ctrlKey: false, metaKey: true }, 'https://example.com/path');
      const spy = (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } })
        .ccsm.openExternal;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('https://example.com/path');
    });

    it('does NOT open external on plain click (no modifier)', () => {
      const handler = getHandler();
      handler({ ctrlKey: false, metaKey: false }, 'https://example.com');
      const spy = (window as unknown as { ccsm: { openExternal: ReturnType<typeof vi.fn> } })
        .ccsm.openExternal;
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not throw when window.ccsm bridge is unavailable', () => {
      const handler = getHandler();
      delete (window as unknown as { ccsm?: unknown }).ccsm;
      expect(() =>
        handler({ ctrlKey: true, metaKey: false }, 'https://example.com'),
      ).not.toThrow();
    });
  });

  // Paste behaviour — the core regression test for v0.2.0 double-paste
  // and v0.2.1/v0.2.2 zero-paste. Both prior fixes had unit tests that
  // passed; both failed in the real app. These tests exercise the actual
  // wiring: the keydown hook installed via `attachCustomKeyEventHandler`,
  // the capture-phase paste listener installed on the host element, and
  // the handoff flag that prevents double-injection.
  describe('paste behaviour', () => {
    let inputSpy: ReturnType<typeof vi.fn>;
    let readTextSpy: ReturnType<typeof vi.fn>;
    let host: HTMLDivElement;

    function getKeyHandler(): (ev: {
      type: string;
      key: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
    }) => boolean {
      const handler = attachCustomKeyEventHandlerSpy.mock.calls[0][0];
      expect(typeof handler).toBe('function');
      return handler;
    }

    beforeEach(() => {
      inputSpy = vi.fn();
      readTextSpy = vi.fn().mockReturnValue('hello');
      (window as unknown as { ccsmPty: unknown }).ccsmPty = {
        input: inputSpy,
        clipboard: {
          readText: readTextSpy,
          writeText: vi.fn(),
        },
        // Task #42 — default to "no image on clipboard" so existing
        // text-paste assertions stay green; image-branch tests override
        // per-case.
        saveClipboardImage: vi.fn().mockResolvedValue(null),
      };
      // The hook receives a real DOM node so the capture-phase paste
      // listener it installs is exercised by real events.
      host = document.createElement('div');
      document.body.appendChild(host);
      renderHook(() => useXtermSingleton({ current: host }));
      // setActiveSid is module-internal; the hook leaves activeSid at
      // null until usePtyAttach wires it. Set it directly via the
      // exported setter so the paste path is reachable.
      setActiveSid('sid-1');
    });

    afterEach(() => {
      document.body.removeChild(host);
      delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    });

    function makePasteEvent(text: string): ClipboardEvent {
      // jsdom doesn't implement DataTransfer; we synthesize a minimal
      // ClipboardEvent + clipboardData shim sufficient for the handler.
      const evt = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(evt, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
      });
      return evt;
    }

    it('Ctrl+V keydown injects clipboard text exactly once', async () => {
      const handler = getKeyHandler();
      const ret = handler({ type: 'keydown', key: 'v', ctrlKey: true });
      expect(ret).toBe(false);
      expect(readTextSpy).toHaveBeenCalledTimes(1);
      // Task #42 — paste now hops through `saveClipboardImage` first; the
      // text injection lands on the microtask after that promise resolves.
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-1', 'hello');
    });

    it('Cmd+V keydown injects clipboard text exactly once (macOS)', async () => {
      const handler = getKeyHandler();
      const ret = handler({ type: 'keydown', key: 'v', metaKey: true });
      expect(ret).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-1', 'hello');
    });

    it('keydown-driven paste suppresses the follow-up native paste event', async () => {
      const handler = getKeyHandler();
      handler({ type: 'keydown', key: 'v', ctrlKey: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);

      // The browser's native paste event arrives after our synchronous
      // keydown handling. It must be swallowed, not turned into a second
      // ccsmPty.input call.
      const evt = makePasteEvent('hello');
      host.dispatchEvent(evt);
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
    });

    it('right-click / context-menu paste (no preceding keydown) injects once', async () => {
      const evt = makePasteEvent('world');
      host.dispatchEvent(evt);
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-1', 'world');
      // xterm's built-in paste pipeline must not see the event.
      expect(evt.defaultPrevented).toBe(true);
    });

    it('handoff flag clears so a later non-keyboard paste is not silently dropped', async () => {
      const handler = getKeyHandler();
      // Keyboard paste with NO follow-up native event (e.g. focus on
      // canvas — browser doesn't dispatch paste to non-editable nodes).
      handler({ type: 'keydown', key: 'v', ctrlKey: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);

      // Wait for the macrotask that resets the flag. We use setTimeout 0
      // (not queueMicrotask) because the browser's native paste event
      // arrives AFTER microtasks but BEFORE the next task tick, so a
      // microtask reset would race the suppression. A real timer tick
      // has to elapse for the reset to fire.
      await new Promise((r) => setTimeout(r, 10));

      // A later paste from a different source must still be delivered.
      const evt = makePasteEvent('later');
      host.dispatchEvent(evt);
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(2);
      expect(inputSpy).toHaveBeenLastCalledWith('sid-1', 'later');
    });

    it('Ctrl+V is a no-op when no active session', async () => {
      setActiveSid(null);
      const handler = getKeyHandler();
      handler({ type: 'keydown', key: 'v', ctrlKey: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).not.toHaveBeenCalled();
    });
  });

  // Task #41: right-click handlers + Ctrl+A select-all. The host div's
  // onContextMenu in TerminalPane calls these directly; we exercise them
  // standalone to pin contract independent of the React wiring (which
  // tests/components/TerminalPane.test.tsx covers separately with mocked
  // singleton). Plus the new Ctrl+A keybinding so the user retains a
  // select-all path after the native menu's "Select All" item is no
  // longer shown for the terminal pane.
  describe('Task #41: terminalCopy / terminalPaste / Ctrl+A', () => {
    let inputSpy: ReturnType<typeof vi.fn>;
    let readTextSpy: ReturnType<typeof vi.fn>;
    let writeTextSpy: ReturnType<typeof vi.fn>;
    let host: HTMLDivElement;

    beforeEach(() => {
      inputSpy = vi.fn();
      readTextSpy = vi.fn().mockReturnValue('pasted-text');
      writeTextSpy = vi.fn();
      (window as unknown as { ccsmPty: unknown }).ccsmPty = {
        input: inputSpy,
        clipboard: {
          readText: readTextSpy,
          writeText: writeTextSpy,
        },
        // Task #42 — default to "no image"; image-branch test overrides
        // per-case to assert the path-injection branch.
        saveClipboardImage: vi.fn().mockResolvedValue(null),
      };
      host = document.createElement('div');
      document.body.appendChild(host);
      renderHook(() => useXtermSingleton({ current: host }));
      setActiveSid('sid-rc');
      getSelectionSpy.mockReset().mockReturnValue('');
      clearSelectionSpy.mockReset();
      selectAllSpy.mockReset();
    });

    afterEach(() => {
      document.body.removeChild(host);
      delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    });

    it('terminalCopy returns true + writes selection + clears it when selection exists', () => {
      getSelectionSpy.mockReturnValue('selected-text');
      const copied = terminalCopy();
      expect(copied).toBe(true);
      expect(writeTextSpy).toHaveBeenCalledWith('selected-text');
      expect(clearSelectionSpy).toHaveBeenCalledTimes(1);
    });

    it('terminalCopy returns false + no clipboard write when selection is empty', () => {
      getSelectionSpy.mockReturnValue('');
      const copied = terminalCopy();
      expect(copied).toBe(false);
      expect(writeTextSpy).not.toHaveBeenCalled();
      expect(clearSelectionSpy).not.toHaveBeenCalled();
    });

    it('terminalPaste reads clipboard and routes through ccsmPty.input', async () => {
      terminalPaste();
      // Async hop via saveClipboardImage; flush microtasks before assert.
      await Promise.resolve();
      await Promise.resolve();
      expect(readTextSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-rc', 'pasted-text');
    });

    it('terminalPaste arms the keyboardPasteHandled flag so a follow-up native paste is suppressed', async () => {
      terminalPaste();
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
      // Synthetic native paste from a different source — must be dropped
      // because terminalPaste just armed the flag.
      const evt = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(evt, 'clipboardData', {
        value: { getData: () => 'should-be-dropped' },
      });
      host.dispatchEvent(evt);
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
    });

    it('terminalPaste is a no-op when no active session', async () => {
      setActiveSid(null);
      terminalPaste();
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).not.toHaveBeenCalled();
    });

    // Task #42 — image-first paste branch. When `saveClipboardImage`
    // returns a saved-file path, we MUST inject that path (not the
    // fallback text) so claude reads the screenshot via the file path.
    it('terminalPaste injects the saved image path when clipboard holds an image', async () => {
      const fakePath = 'C:\\Users\\me\\AppData\\Roaming\\CCSM\\clipboard-images\\20260522-100000.png';
      (window as unknown as { ccsmPty: { saveClipboardImage: ReturnType<typeof vi.fn> } })
        .ccsmPty.saveClipboardImage = vi.fn().mockResolvedValue(fakePath);
      terminalPaste();
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-rc', fakePath);
      // The synchronously-read text MUST NOT be injected; the image branch
      // wins.
      expect(inputSpy).not.toHaveBeenCalledWith('sid-rc', 'pasted-text');
    });

    // Task #42 — text fallback. When `saveClipboardImage` returns null
    // (no image on clipboard), the previously-read text is injected as
    // the regular paste payload. Default beforeEach stub already returns
    // null, but spell it out for documentation.
    it('terminalPaste falls back to text injection when no image is on clipboard', async () => {
      (window as unknown as { ccsmPty: { saveClipboardImage: ReturnType<typeof vi.fn> } })
        .ccsmPty.saveClipboardImage = vi.fn().mockResolvedValue(null);
      terminalPaste();
      await Promise.resolve();
      await Promise.resolve();
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-rc', 'pasted-text');
    });

    // N1 race fix (reviewer): `saveClipboardImage` is an async IPC hop;
    // if the user switches sessions while it's in flight, the injected
    // text / image-path MUST land in the session that was active at
    // paste-intent time, NOT whichever session happens to be active
    // when the promise resolves. `pasteIntoActivePty` snapshots
    // `activeSid` at entry to enforce this. Drive the helper directly
    // (rather than through `terminalPaste`) so the timing is precise.
    it('pasteIntoActivePty binds the target sid at intent time, not at promise-resolution time', async () => {
      // Defer the resolution of saveClipboardImage until we explicitly
      // resolve it — gives us a clean window to flip activeSid mid-flight.
      let resolveImage: (v: string | null) => void = () => {};
      const pending = new Promise<string | null>((r) => { resolveImage = r; });
      (window as unknown as { ccsmPty: { saveClipboardImage: ReturnType<typeof vi.fn> } })
        .ccsmPty.saveClipboardImage = vi.fn().mockReturnValue(pending);

      setActiveSid('sid-original');
      const pasted = pasteIntoActivePty('typed-into-original');

      // Simulate the user switching sessions while we wait on the IPC.
      setActiveSid('sid-different');

      // Resolve the IPC with no image so we exercise the text-fallback
      // branch (the more dangerous one — image path comes from main and
      // is obviously global, but the text fallback could plausibly look
      // session-scoped if you squint at the old code).
      resolveImage(null);
      await pasted;

      // MUST go to the sid that was active when paste was invoked, not
      // the sid that's active now.
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(inputSpy).toHaveBeenCalledWith('sid-original', 'typed-into-original');
      expect(inputSpy).not.toHaveBeenCalledWith('sid-different', 'typed-into-original');
    });

    it('Ctrl+A invokes term.selectAll() and returns false to stop SOH translation', () => {
      const handler = attachCustomKeyEventHandlerSpy.mock.calls[0][0];
      const ret = handler({ type: 'keydown', key: 'a', ctrlKey: true });
      expect(ret).toBe(false);
      expect(selectAllSpy).toHaveBeenCalledTimes(1);
    });

    it('Cmd+A also invokes term.selectAll() (macOS)', () => {
      const handler = attachCustomKeyEventHandlerSpy.mock.calls[0][0];
      const ret = handler({ type: 'keydown', key: 'a', metaKey: true });
      expect(ret).toBe(false);
      expect(selectAllSpy).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+Shift+A does NOT select-all (shift modifier reserved for other bindings)', () => {
      const handler = attachCustomKeyEventHandlerSpy.mock.calls[0][0];
      const ret = handler({ type: 'keydown', key: 'A', ctrlKey: true, shiftKey: true });
      // Shift+A is not one of our explicit shifted bindings (only C/V are);
      // returning true keeps xterm's default handling intact.
      expect(ret).toBe(true);
      expect(selectAllSpy).not.toHaveBeenCalled();
    });

    it('plain "a" keydown (no modifier) is left to xterm as normal input', () => {
      const handler = attachCustomKeyEventHandlerSpy.mock.calls[0][0];
      const ret = handler({ type: 'keydown', key: 'a' });
      expect(ret).toBe(true);
      expect(selectAllSpy).not.toHaveBeenCalled();
    });
  });
});
