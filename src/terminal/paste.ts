// Shared, stateless paste module (PR — remove CCSM_WARM_XTERM flag).
//
// Originally lived as module-scope state inside `xtermSingleton.ts`. That
// shape coupled paste behaviour to a renderer-wide singleton Terminal,
// which the per-session warm-xterm registry replaces: there is now ONE
// Terminal per sid, so paste must operate on whichever entry is currently
// active. We factor the behaviour into pure helpers that the caller hands
// the right Terminal to — no module state, no implicit "current" lookup.
//
// Transparent-transport invariant (project memory):
//   * `preparePastePayload` rewrites ONLY CR bytes (→ LF) and adds the
//     bracketed-paste sentinels around the WHOLE payload. No chunking,
//     no length cap, no content-shaped rewriting.
//   * `pasteIntoActivePty` issues exactly ONE `ccsmPty.input(sid, payload)`
//     per paste — the bracketed sentinels and payload travel as a single
//     atomic IPC, so claude's TUI receives them in-order on the same tick.
//
// All paste paths (capture-phase DOM listener, Ctrl/Cmd+V keydown,
// right-click contextmenu) funnel through `pasteIntoActivePty` so the
// image-first pipeline (Task #42) and bracketed-paste handling run in
// exactly one place.

import type { Terminal } from '@xterm/xterm';
import { log } from '../shared/log';
import { normalizeError } from '../shared/scrub';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Prepare a clipboard payload for injection into the PTY:
 *   1. Normalize CRLF → LF (and lone CR → LF). Windows clipboards
 *      (notepad, most browsers) hand back CRLF; PTYs / claude treat each
 *      `\r` as a submit. Without this, every multi-line Windows paste
 *      fires the prompt after the first line.
 *   2. If the active xterm reports bracketed-paste mode (claude's Ink TUI
 *      sends `\x1b[?2004h` on startup), wrap the result in
 *      `\x1b[200~ ... \x1b[201~` so the app treats the whole payload as
 *      a single paste, not as typed input. Without this: embedded `\n`
 *      submits prematurely, embedded `\x03` SIGINTs claude, embedded ANSI
 *      escapes are interpreted as terminal commands.
 *
 * Pure 2-arg helper so the contract property test
 * (`tests/contract/paste-normalization.property.test.ts`) can exercise
 * the production normalizer directly.
 */
export function preparePastePayload(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return bracketed
    ? `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`
    : normalized;
}

/** Read the live bracketed-paste mode from a Terminal. Returns `false`
 *  when undefined (e.g. fake terminals in tests). */
function getBracketedPasteMode(term: Terminal | undefined): boolean {
  return term?.modes?.bracketedPasteMode === true;
}

/**
 * Task #42 — image-first paste pipeline. Shared by every paste entry
 * point. The caller provides a getter for the currently-active Terminal
 * (typically `getActiveEntry()?.term` from the warm registry) and the
 * target sid; we read bracketed-paste mode off the Terminal at injection
 * time and emit a single `ccsmPty.input` call.
 *
 * `fallbackText` is read synchronously by the caller (clipboardData for
 * the capture-phase listener; `clipboard.readText()` for keyboard /
 * right-click) so the text survives the async hop to main's
 * `saveClipboardImage`.
 *
 * Why image-first: on Windows, `clipboard.readText()` is unreliable when
 * the clipboard also holds an image (returns empty / stale text), but
 * `readImage().isEmpty()` IS reliable. So we ask main "is there an
 * image" first; if yes, main writes it under
 * `<userData>/clipboard-images/` and returns the absolute path, which
 * we inject into the PTY. Claude reads files by path, so a pasted
 * screenshot becomes "claude can see the screenshot" with no extra
 * user steps.
 */
export async function pasteIntoActivePty(
  getActiveTerm: () => Terminal | undefined,
  sid: string,
  fallbackText: string | undefined,
): Promise<void> {
  if (!sid) return;
  // PR B Stage 2 probe: paste capture stage. Boundary metadata only —
  // no clipboard content. `bytes` is the inbound text length (the image
  // path is unknown at this point).
  log.event('paste.hop', {
    sid,
    stage: 'capture',
    bytes: fallbackText?.length ?? 0,
    bracketed: getBracketedPasteMode(getActiveTerm()),
  });
  try {
    const imagePath = await window.ccsmPty?.saveClipboardImage?.();
    if (imagePath) {
      const bracketed = getBracketedPasteMode(getActiveTerm());
      const payload = preparePastePayload(imagePath, bracketed);
      log.event('paste.branch', { sid, branch: 'image' });
      log.event('paste.hop', { sid, stage: 'prepare', bytes: payload.length, bracketed });
      log.event('paste.hop', { sid, stage: 'ipc-send', bytes: payload.length, bracketed });
      try {
        window.ccsmPty.input(sid, payload);
        log.event('paste.hop', { sid, stage: 'pty-write', bytes: payload.length, bracketed });
      } catch (e) {
        log.error('paste', 'pty-write failed', {
          sid,
          stage: 'pty-write',
          error: normalizeError(e),
        });
      }
      return;
    }
  } catch (e) {
    log.error('paste', 'saveClipboardImage failed', {
      sid,
      stage: 'ipc-send',
      error: normalizeError(e),
    });
  }
  if (fallbackText) {
    const bracketed = getBracketedPasteMode(getActiveTerm());
    const bytesBefore = fallbackText.length;
    const crlfFound = /\r\n|\r/.test(fallbackText);
    const payload = preparePastePayload(fallbackText, bracketed);
    const bytesAfter = bracketed
      ? payload.length - BRACKETED_PASTE_START.length - BRACKETED_PASTE_END.length
      : payload.length;
    log.event('paste.normalized', { sid, bytesBefore, bytesAfter, crlfFound });
    log.event('paste.branch', { sid, branch: 'text' });
    log.event('paste.hop', { sid, stage: 'prepare', bytes: payload.length, bracketed });
    log.event('paste.hop', { sid, stage: 'ipc-send', bytes: payload.length, bracketed });
    try {
      // Single-shot input: transparent transport. The bracketed payload
      // travels as one IPC; claude sees the sentinels and payload on the
      // same parse tick. Do NOT chunk.
      window.ccsmPty.input(sid, payload);
      log.event('paste.hop', { sid, stage: 'pty-write', bytes: payload.length, bracketed });
    } catch (e) {
      log.error('paste', 'pty-write failed', {
        sid,
        stage: 'pty-write',
        error: normalizeError(e),
      });
    }
  } else {
    log.event('paste.branch', { sid, branch: 'empty' });
  }
}

/**
 * Copy current selection to the clipboard. Returns `true` iff a selection
 * existed and was copied (caller uses this to choose between copy and
 * paste branches without re-reading `getSelection`). `clearSelection`
 * happens here too so the user gets visual feedback.
 *
 * No-op (returns false) when `term` is undefined or selection is empty.
 */
export function terminalCopy(term: Terminal | undefined): boolean {
  if (!term) return false;
  const sel = term.getSelection();
  if (!sel) return false;
  try {
    window.ccsmPty?.clipboard?.writeText(sel);
  } catch {
    // ignore — selection still highlights, user can retry.
  }
  try {
    term.clearSelection();
  } catch {
    // best-effort.
  }
  return true;
}

/**
 * Right-click / keyboard-V paste sink. Reads the clipboard synchronously
 * (best-effort) and funnels through `pasteIntoActivePty` so the
 * image-first pipeline runs regardless of entry point. No-op when no
 * Terminal exists or sid is empty.
 *
 * `branch` is a discrete tag for the entry-point probe — `'right-click'`
 * for the contextmenu route, `'ctrl-v'` for the keydown handler.
 */
export async function terminalPaste(
  getActiveTerm: () => Terminal | undefined,
  sid: string,
  branch: 'right-click' | 'ctrl-v',
): Promise<void> {
  const term = getActiveTerm();
  if (!term || !sid) return;
  let text: string | undefined;
  try {
    text = window.ccsmPty?.clipboard?.readText() || undefined;
  } catch {
    // best-effort — clipboard read can fail under permission edge cases.
  }
  log.event('paste.branch', { sid, branch });
  await pasteIntoActivePty(getActiveTerm, sid, text);
}
