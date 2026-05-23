import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';
import { useStore } from '../stores/store';
import { SCROLLBACK_LINES_DEFAULT } from '../stores/slices/types';
import { warn } from '../shared/log';

// Module-scope singleton state for the renderer's xterm view.
//
// Why a module-scope singleton (NOT per-React-mount):
//   - Recreating the Terminal on every session switch is expensive: the
//     canvas renderer rebuilds its glyph atlas, addons re-allocate, and
//     in dev React StrictMode would double-invoke the constructor.
//   - ccsm's session-keepalive guarantee: the user can flip between
//     sessions without the underlying terminal/PTY pairing being torn
//     down. The PTY lives in the main process; the rendered view is a
//     single xterm bound to whichever sid is active. Switching sessions
//     = `term.reset()` + IPC re-attach with the new sid's snapshot, no
//     DOM reconstruction.
//
// All three terminal hooks (useXtermSingleton, usePtyAttach,
// useTerminalResize) share this state via the accessors below.
//
// `window.ccsmPty` and `window.__ccsmTerm` are typed via `src/pty.d.ts`,
// which is the canonical renderer-side view of the preload bridge surface.

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let activeSid: string | null = null;
let unsubscribeData: (() => void) | null = null;
let inputDisposable: { dispose: () => void } | null = null;
// Handoff flag between the Ctrl/Cmd+V keydown hook and the capture-phase
// `paste` listener. Module-level (not closed over `ensureTerminal`) so a
// keydown that was attached against an earlier Terminal instance still
// suppresses the native paste event reaching the current host element.
// See the paste-path block inside `ensureTerminal` for details.
let keyboardPasteHandled = false;
// IME composition state: while a Chinese/Japanese/Korean IME is composing,
// every term.write reanchors xterm's hidden textarea and makes the
// composition preview box jump around. Buffer pty chunks until compositionend.
let isComposing = false;
let imeBuffer = '';

export function writeOrBuffer(chunk: string): void {
  if (isComposing) {
    imeBuffer += chunk;
    return;
  }
  term?.write(chunk);
}
// L4 PR-D (#866): callback installed by `usePtyAttach` once it has wired the
// snapshot/dedupe-by-seq flow. Invoked by `useTerminalResize` AFTER pushing
// a new size to the headless mirror so the visible xterm can re-render
// from the reflowed buffer's cell content rather than waiting on claude
// to repaint (claude's TUI is alt-screen and does not repaint on
// SIGWINCH unless input arrives — same root cause as #852). The handler
// is responsible for: (1) requesting a fresh `getBufferSnapshot`,
// (2) re-installing the buffering listener so live chunks during the
// replay window aren't lost, (3) writing the snapshot, (4) bumping
// the per-attach `snapSeq` to the snapshot's seq so subsequent live
// chunks dedupe correctly.
let snapshotReplay: (() => Promise<void>) | null = null;

export function getTerm(): Terminal | null {
  return term;
}

/**
 * Park the viewport at the bottom AFTER all queued writes have drained.
 *
 * xterm's `Terminal.write` is asynchronous: it pushes into an internal
 * `WriteBuffer` that's flushed on the next microtask/raf. A synchronous
 * `scrollToBottom()` immediately after `write(snapshot)` runs BEFORE the
 * snapshot has actually advanced `baseY`, so the viewport ends up parked
 * at the OLD bottom (which, after `term.reset()`, is row 0 — i.e. the
 * top of the now-populated transcript). This is the bug behind "attach a
 * session and the scrollbar lands at the middle/top of the transcript".
 *
 * The fix is the documented xterm idiom: pass a callback to `write`, which
 * fires after the WriteBuffer has drained THIS chunk, and only THEN call
 * `scrollToBottom()`. Empty-string writes are cheap (no parsing) and still
 * cause the callback to be queued behind any prior pending writes, so we
 * use `term.write('', cb)` as the rendezvous point regardless of how many
 * `term.write(...)` calls preceded it.
 *
 * Used by `usePtyAttach` at every attach-path call site that paints into
 * the terminal: initial snapshot + buffered drain, snapshot-replay tail,
 * and the post-attach fit branch's replay. The resize path (in
 * `useTerminalResize`) is gated on the user's prior atBottom state so a
 * scrolled-up viewport isn't yanked down by a SIGWINCH.
 */
export function writeAndScrollToBottom(t: Terminal): void {
  t.write('', () => {
    try {
      t.scrollToBottom();
    } catch {
      // best-effort — xterm may have been torn down between queue and drain.
    }
  });
}

export function getFit(): FitAddon | null {
  return fit;
}

export function getActiveSid(): string | null {
  return activeSid;
}

export function setActiveSid(sid: string | null): void {
  activeSid = sid;
}

export function getUnsubscribeData(): (() => void) | null {
  return unsubscribeData;
}

export function setUnsubscribeData(fn: (() => void) | null): void {
  unsubscribeData = fn;
}

export function getInputDisposable(): { dispose: () => void } | null {
  return inputDisposable;
}

export function setInputDisposable(d: { dispose: () => void } | null): void {
  inputDisposable = d;
}

/**
 * L4 PR-D (#866): get the snapshot-replay handler installed by `usePtyAttach`.
 * Returns null when no session is attached. Callers (currently only
 * `useTerminalResize`) await the returned promise so they can sequence
 * subsequent work after the replay completes.
 */
export function getSnapshotReplay(): (() => Promise<void>) | null {
  return snapshotReplay;
}

export function setSnapshotReplay(fn: (() => Promise<void>) | null): void {
  snapshotReplay = fn;
}

/**
 * Task #42 — image-first paste pipeline (shared by every paste path:
 * capture-phase DOM event in `ensureTerminal`, Ctrl/Cmd+V keydown via
 * `pasteFromClipboard`, right-click via `terminalPaste`).
 *
 * Why image-first: on Windows, `clipboard.readText()` is unreliable when
 * the clipboard also holds an image (returns empty / stale text), but
 * `readImage().isEmpty()` IS reliable. So we ask main "is there an image"
 * first; if yes, main writes it under `<userData>/clipboard-images/` and
 * returns the absolute path, which we inject into the PTY. Claude reads
 * files by path, so this turns a pasted screenshot into "claude can see
 * the screenshot" with no extra user steps.
 *
 * `fallbackText` is read by the caller synchronously (clipboardData for
 * the capture-phase listener; `clipboard.readText()` for the keyboard /
 * right-click paths) so the text survives the async hop to main.
 *
 * Returns the promise so callers that need to sequence after the paste
 * (currently only tests) can await; production paste paths fire-and-forget
 * via `void`.
 */
/**
 * Prepare a clipboard payload for injection into the PTY:
 *   1. Normalize CRLF → LF (and lone CR → LF). Windows clipboards (notepad,
 *      most browsers) hand back CRLF; PTYs / claude treat each `\r` as a
 *      submit. Without this, every multi-line Windows paste fires the prompt
 *      after the first line and the rest lands in fresh prompts.
 *   2. If xterm reports bracketed-paste mode active (claude's Ink TUI sends
 *      `\x1b[?2004h` on startup), wrap in `\x1b[200~ ... \x1b[201~` so the
 *      app treats the whole payload as paste, not typed input. Without this:
 *      embedded `\n` submits prematurely, embedded `\x03` SIGINTs claude,
 *      and embedded ANSI escapes are interpreted as terminal commands.
 *
 * Read `term.modes.bracketedPasteMode` (xterm.js IModes — updated live by
 * the parser as the app sends DECSET 2004 h/l). Falls back to "no wrap" if
 * the singleton hasn't been constructed yet (e.g. paste fired before the
 * terminal mounted — shouldn't happen, but the early-return is cheap).
 */
function preparePastePayload(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const bracketed = term?.modes?.bracketedPasteMode === true;
  return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}

export async function pasteIntoActivePty(fallbackText: string | undefined): Promise<void> {
  // N1 race fix (reviewer): snapshot `activeSid` BEFORE the async IPC hop.
  // `saveClipboardImage` round-trips to main; the user can switch sessions
  // during that window. Without this snapshot, the saved image path (or
  // fallback text) would land in whichever session happens to be active
  // when the promise resolves — i.e. the wrong one. Bind the target sid
  // at intent time so the inject always goes to the session the user was
  // looking at when they hit paste.
  const sid = activeSid;
  if (!sid) return;
  try {
    const imagePath = await window.ccsmPty?.saveClipboardImage?.();
    if (imagePath) {
      // Image path is a single-line string with no CR, but route it through
      // the same prep so bracketed-paste wrapping applies — claude must see
      // the path as one atomic paste, not as keystrokes that could collide
      // with TUI keybindings while the path streams in.
      window.ccsmPty.input(sid, preparePastePayload(imagePath));
      return;
    }
  } catch {
    // best-effort — fall through to text paste on IPC failure.
  }
  if (fallbackText) window.ccsmPty.input(sid, preparePastePayload(fallbackText));
}

/**
 * Create (or re-attach) the singleton Terminal against `host`. Idempotent:
 * subsequent calls reuse the cached instance and only re-`open` if React
 * remounted into a different DOM node.
 */
export function ensureTerminal(host: HTMLDivElement): Terminal {
  if (term) {
    if ((term as any)._core?._parent !== host) {
      try {
        term.open(host);
      } catch {
        // open() throws if already attached to this exact host; ignore.
      }
    }
    return term;
  }

  // The scrollback cap is read ONCE at construction. Changing the user
  // setting after the singleton exists does not retroactively resize the
  // visible buffer (xterm.js doesn't expose a mutable scrollback setter),
  // so the SettingsDialog helper text says "applies on next launch". Read
  // synchronously from the zustand store, which `hydrateStore()` populates
  // from db:load before TerminalPane mounts (App.tsx gates on `hydrated`).
  // Falls back to the default constant if the store somehow isn't ready
  // yet (e.g. test mounts that bypass hydrate).
  const scrollback =
    useStore.getState().scrollbackLines ?? SCROLLBACK_LINES_DEFAULT;
  term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 13,
    // cursorBlink:false is deliberate. xterm-canvas CursorRenderLayer
    // restarts the blink phase on every grid change (see
    // node_modules/@xterm/addon-canvas/src/CursorRenderLayer.ts:107-113),
    // so a TUI that rewrites a status line each second (e.g. claude code's
    // "1m 28s" tool timer) produces visible cursor strobing. VS Code's
    // integrated terminal defaults to blink-off for the same reason.
    cursorBlink: false,
    allowProposedApi: true,
    scrollback,
    theme: { background: '#000000' },
    // Wheel-scroll tuning. xterm's `Viewport.getLinesScrolled` multiplies
    // `event.deltaY` by `scrollSensitivity` BEFORE dividing by row height
    // (~17px at our 13px font), so a Windows precision-mouse / touchpad
    // notch reporting `deltaY` in the 100–400px range with the default
    // sensitivity of 1 lands the user 6–25 lines down per notch — "a
    // light flick scrolls to the middle of the page" reported in dogfood.
    // 0.5 brings a ~120px notch back to ~3 lines, matching a native CLI
    // terminal's feel without making intentional fast scrolls sluggish
    // (the Alt modifier still gives 5x for long jumps).
    //
    // 0.5 is also safe for low-deltaY trackpads: xterm's Viewport keeps a
    // `_wheelPartialScroll %= 1` accumulator (Viewport.ts:360-362) that
    // carries the sub-row remainder across wheel events, so a trackpad
    // emitting `deltaY` in the 4–10px range still scrolls smoothly — the
    // partial line just lands on the next event instead of being dropped.
    //
    // `fastScrollSensitivity` and `fastScrollModifier` are pinned to their
    // current xterm defaults explicitly — manager-pinned to defend against
    // upstream default drift; if a future xterm starts treating
    // `fastScrollModifier: 'alt'` as default-fast, the runaway scroll
    // returns silently.
    scrollSensitivity: 0.5,
    fastScrollSensitivity: 5,
    fastScrollModifier: 'alt',
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  try {
    // Ctrl-click (Win/Linux) / Cmd-click (macOS) opens the link in the
    // user's default browser; plain clicks are deliberately a no-op.
    //
    // Why the modifier gate: matches the Windows Terminal / VS Code
    // convention so muscle memory carries over, and avoids hijacking
    // accidental clicks on URL-shaped output (paths, ANSI escapes that
    // look like links, etc.) from claude's TUI.
    //
    // Why route through preload (not WebLinksAddon's default `window.open`):
    // the BrowserWindow installs a `setWindowOpenHandler` returning
    // `{action:'deny'}` to block popups, which silently swallows the
    // default behaviour. `window.ccsm.openExternal` hands the URI to the
    // main process, which applies a strict http(s) scheme whitelist
    // before calling `shell.openExternal` (see utilityIpc.ts).
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) {
          window.ccsm?.openExternal?.(uri);
        }
      }),
    );
  } catch (e) {
    warn('xterm', 'web-links addon failed', e);
  }
  try {
    term.loadAddon(new ClipboardAddon());
  } catch (e) {
    warn('xterm', 'clipboard addon failed', e);
  }
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch (e) {
    warn('xterm', 'unicode11 addon failed', e);
  }
  // Canvas renderer is the safe middle ground (DOM is slow on dense
  // output, WebGL flakes under RDP). Fall back silently to default DOM
  // renderer if the GPU path can't initialise.
  try {
    term.loadAddon(new CanvasAddon());
  } catch (e) {
    warn('xterm', 'canvas addon failed, falling back to DOM', e);
  }

  term.open(host);

  const ta = term.textarea;
  if (ta) {
    ta.addEventListener('compositionstart', () => {
      isComposing = true;
    });
    ta.addEventListener('compositionend', () => {
      isComposing = false;
      if (imeBuffer) {
        const pending = imeBuffer;
        imeBuffer = '';
        term?.write(pending);
      }
    });
  }

  // Single canonical paste path.
  //
  // xterm.js exposes two competing entry points for paste:
  //   (1) an `attachCustomKeyEventHandler` keydown hook
  //   (2) a built-in `paste` DOM-event pipeline (`handlePasteEvent` →
  //       `coreService.triggerDataEvent` → `onData`), wired to BOTH
  //       `this.textarea` and `this.element`.
  //
  // Electron adds a third: `role: 'paste'` in any application menu
  // resolves Ctrl/Cmd+V via `webContents.paste()` (OS-level), which
  // bypasses the DOM entirely. (We've removed that role from the
  // hidden accelerator menu in `electron/lifecycle/appLifecycle.ts`,
  // but it can still arrive from the right-click context menu.)
  //
  // Letting two of these fire concurrently is what caused v0.2.0's
  // double-paste; disabling the keydown hook (v0.2.1) instead left
  // paste depending on which descendant of host happened to be
  // focused, manifesting as zero pastes when focus was on the screen
  // canvas. Both failure modes have the same root cause: we were
  // riding xterm's internals instead of owning the user intent.
  //
  // Fix: own the user intent. Treat the terminal pane as a single
  // atomic unit, like a native CLI terminal. Every "user wants to
  // paste" signal — Ctrl/Cmd+V keydown, Ctrl/Cmd+Shift+V keydown,
  // bracketed `paste` DOM events — converges on one call:
  //
  //   ccsmPty.input(activeSid, clipboard.readText())
  //
  // Implementation: install a capture-phase `paste` listener on the
  // host wrapper that swallows xterm's built-in pipeline before it
  // can call `triggerDataEvent`, and route Ctrl/Cmd+V via the
  // keydown hook below (returning `false` to also stop xterm from
  // translating the keystroke into a 0x16 SYN byte).
  //
  // The capture listener also routes `paste` events that did NOT
  // originate from our keydown hook (right-click → Paste, Shift+Insert,
  // OS-level `webContents.paste()` via context menu) into the same
  // canonical sink, so every paste source converges.
  //
  // Subtlety: when the user types Ctrl+V, the keydown hook reads the
  // clipboard and injects synchronously. Some browsers / Electron
  // versions then dispatch a native `paste` event a moment later;
  // the keydown handler sets `keyboardPasteHandled` so this listener
  // discards that follow-up event and we paste exactly once.
  // Task #42 — image-first paste pipeline. See `pasteIntoActivePty` at
  // module scope: every paste path (capture-phase DOM event, Ctrl/Cmd+V
  // keydown, right-click `terminalPaste`) funnels through that helper so
  // pasted screenshots auto-save and inject as a path.
  const onPasteCapture = (e: ClipboardEvent): void => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (keyboardPasteHandled) {
      keyboardPasteHandled = false;
      return;
    }
    // Read text synchronously: clipboardData is only valid during the
    // event dispatch, so we can't await before reading it.
    const text = e.clipboardData?.getData('text/plain') ?? '';
    void pasteIntoActivePty(text || undefined);
  };
  host.addEventListener('paste', onPasteCapture, { capture: true });

  // ttyd-style: auto-copy on selection change. Works in alt-screen apps
  // (claude/Ink) when user holds Shift to bypass mouse tracking and
  // drags. Use Electron's clipboard via preload because navigator.clipboard
  // requires user-activation that xterm's keydown swallow doesn't reliably
  // propagate, and silently fails under default contextIsolation.
  term.onSelectionChange(() => {
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      try {
        window.ccsmPty?.clipboard?.writeText(sel);
      } catch {
        // ignore clipboard failures — selection still highlights.
      }
    }
  });

  const pasteFromClipboard = (): void => {
    keyboardPasteHandled = true;
    // Reset the flag on a macrotask (NOT a microtask). The browser dispatches
    // the follow-up native `paste` event after our keydown handler returns
    // but before the next task tick — microtasks fire BEFORE the native
    // paste, leaving the flag false when the capture listener runs and
    // causing a second inject (the v0.2.0 double-paste comes back). A
    // setTimeout 0 task lands AFTER the native paste dispatch, so the
    // capture listener sees the flag and suppresses.
    setTimeout(() => { keyboardPasteHandled = false; }, 0);
    let text: string | undefined;
    try {
      text = window.ccsmPty?.clipboard?.readText() || undefined;
    } catch {
      // best-effort — clipboard read can fail under permission edge cases.
    }
    // Task #42 — route through the image-first helper so a copied
    // screenshot lands as a file path rather than empty text.
    void pasteIntoActivePty(text);
  };

  // Copy/paste keyboard shortcuts (Windows Terminal style):
  //   Ctrl+C  → if selection, copy; else fall through to SIGINT
  //   Ctrl+V  → paste (single canonical path, see above)
  //   Ctrl+A  → select-all (xterm has no built-in; we wire it here so the
  //             keyboard offers parity with the previous native context
  //             menu's "Select All" item)
  //   Ctrl+Shift+C / Ctrl+Shift+V → explicit always-clipboard
  // On macOS the same handler matches Cmd via `metaKey`.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod || ev.altKey) return true;
    const isC = ev.key === 'C' || ev.key === 'c';
    const isV = ev.key === 'V' || ev.key === 'v';
    const isA = ev.key === 'A' || ev.key === 'a';

    if (!ev.shiftKey && isA) {
      // Ctrl/Cmd+A → select-all. xterm has no built-in keybinding for
      // this, and removing the native right-click "Select All" item (in
      // favor of native CLI right-click behavior) leaves the user with
      // no other entry point. Returning `false` keeps xterm from also
      // translating the keystroke into a 0x01 SOH control byte.
      try {
        term?.selectAll();
      } catch {
        // ignore — best-effort.
      }
      return false;
    }
    if (!ev.shiftKey && isC) {
      const sel = term?.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {
          // ignore clipboard failures — selection still highlights.
        }
        return false;
      }
      return true;
    }
    if (!ev.shiftKey && isV) {
      pasteFromClipboard();
      return false;
    }
    if (ev.shiftKey && isC) {
      const sel = term?.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {
          // ignore clipboard failures — selection still highlights.
        }
      }
      return false;
    }
    if (ev.shiftKey && isV) {
      pasteFromClipboard();
      return false;
    }
    return true;
  });

  // Probe hook for e2e harness — exposed unconditionally because the
  // direct-xterm probes (harness-real-cli pty-pid-stable-across-switch /
  // switch-session-keeps-chat) drive the production webpack bundle and
  // would otherwise have no way to reach the live Terminal handle. This
  // mirrors the unconditional `window.__ccsmStore` exposure in App.tsx —
  // a debug affordance, not a security boundary, since the renderer is
  // already a single-origin Electron context with no remote content.
  window.__ccsmTerm = term;

  return term;
}

/**
 * Test-only: clear singleton state so each test starts from a clean slate.
 * Intentionally NOT exported via barrel — only direct importers (tests)
 * should reach for it.
 */
export function __resetSingletonForTests(): void {
  term = null;
  fit = null;
  activeSid = null;
  unsubscribeData = null;
  inputDisposable = null;
  snapshotReplay = null;
  keyboardPasteHandled = false;
  isComposing = false;
  imeBuffer = '';
  if (typeof window !== 'undefined') {
    delete window.__ccsmTerm;
  }
}

/**
 * Right-click handlers — called from `TerminalPane`'s `onContextMenu` to
 * implement native CLI/terminal behavior (Windows Terminal / gnome-terminal
 * style): right-click with selection copies + clears, right-click without
 * selection pastes. No popover, ever.
 *
 * `terminalCopy` returns `true` iff a selection existed and was copied
 * (caller uses this to choose between copy and paste branches without
 * having to re-read `getSelection`). `clearSelection` happens here too so
 * the user gets visual feedback that the copy landed.
 *
 * `terminalPaste` routes through the same canonical paste sink as the
 * Ctrl+V keydown hook (see `pasteFromClipboard` block above) — sets the
 * `keyboardPasteHandled` flag so the capture-phase paste listener
 * suppresses any follow-up native paste event, reads clipboard via
 * `ccsmPty.clipboard.readText()`, writes via `ccsmPty.input(activeSid)`.
 *
 * Both are no-ops when no Terminal exists yet (pane unmounted).
 */
export function terminalCopy(): boolean {
  if (!term) return false;
  const sel = term.getSelection();
  if (!sel) return false;
  try {
    window.ccsmPty?.clipboard?.writeText(sel);
  } catch {
    // ignore — selection still highlights, user can ctrl+c retry.
  }
  try {
    term.clearSelection();
  } catch {
    // ignore — visual feedback is best-effort.
  }
  return true;
}

export function terminalPaste(): void {
  if (!term || !activeSid) return;
  // Reuse the same handoff flag the keydown handler uses; the capture-phase
  // paste listener installed in `ensureTerminal` checks it to suppress a
  // duplicate inject from any browser-dispatched follow-up `paste` event.
  // `setTimeout(0)` (NOT `queueMicrotask`) — see comment on
  // `pasteFromClipboard` inside ensureTerminal.
  keyboardPasteHandled = true;
  setTimeout(() => {
    keyboardPasteHandled = false;
  }, 0);
  let text: string | undefined;
  try {
    text = window.ccsmPty?.clipboard?.readText() || undefined;
  } catch {
    // best-effort — clipboard read can fail under permission edge cases.
  }
  // Task #42 — route through the image-first helper so right-click on a
  // copied screenshot lands as a file path rather than empty text.
  void pasteIntoActivePty(text);
}
