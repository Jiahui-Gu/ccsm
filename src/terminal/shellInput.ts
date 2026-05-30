import { warn } from '../shared/log';
import { pasteIntoActivePty } from './paste';
import type { Shell } from './shellTypes';

// Input-side listeners: IME composition guard, capture-phase paste,
// selection-to-clipboard auto-copy, Ctrl/Cmd+C/V/A handler. Same surface
// as the legacy registry (these are UX features, not race handling).
export function installInputListeners(shell: Shell): void {
  const { term, sid, wrapper } = shell;
  const ta = term.textarea;
  if (ta) {
    const onStart = () => {
      shell.composing = true;
      shell.composingBuffer.length = 0;
    };
    const onEnd = () => {
      shell.composing = false;
      if (shell.composingBuffer.length > 0) {
        const pending = shell.composingBuffer.join('');
        shell.composingBuffer.length = 0;
        try {
          term.write(pending);
        } catch {
          /* best-effort */
        }
      }
    };
    ta.addEventListener('compositionstart', onStart);
    ta.addEventListener('compositionend', onEnd);
    shell.inputDisposers.push(() => {
      try {
        ta.removeEventListener('compositionstart', onStart);
      } catch {
        /* ignore */
      }
      try {
        ta.removeEventListener('compositionend', onEnd);
      } catch {
        /* ignore */
      }
    });
  }

  let keyboardPasteHandled = false;
  const onPasteCapture = (e: ClipboardEvent): void => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (keyboardPasteHandled) {
      keyboardPasteHandled = false;
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    void pasteIntoActivePty(() => shell.term, sid, text || undefined);
  };
  wrapper.addEventListener('paste', onPasteCapture, true);
  shell.inputDisposers.push(() => {
    try {
      wrapper.removeEventListener('paste', onPasteCapture, true);
    } catch {
      /* ignore */
    }
  });

  try {
    const selDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {
          /* ignore */
        }
      }
    });
    shell.inputDisposers.push(() => {
      try {
        selDisposable?.dispose?.();
      } catch {
        /* ignore */
      }
    });
  } catch (e) {
    warn('shell', 'onSelectionChange attach failed', e);
  }

  const pasteFromClipboard = (): void => {
    keyboardPasteHandled = true;
    setTimeout(() => {
      keyboardPasteHandled = false;
    }, 0);
    let text: string | undefined;
    try {
      text = window.ccsmPty?.clipboard?.readText() || undefined;
    } catch {
      /* best-effort */
    }
    void pasteIntoActivePty(() => shell.term, sid, text);
  };
  try {
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod || ev.altKey) return true;
      const isC = ev.key === 'C' || ev.key === 'c';
      const isV = ev.key === 'V' || ev.key === 'v';
      const isA = ev.key === 'A' || ev.key === 'a';
      if (!ev.shiftKey && isA) {
        try {
          term.selectAll();
        } catch {
          /* ignore */
        }
        return false;
      }
      if (!ev.shiftKey && isC) {
        const sel = term.getSelection();
        if (sel) {
          try {
            window.ccsmPty?.clipboard?.writeText(sel);
          } catch {
            /* ignore */
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
        const sel = term.getSelection();
        if (sel) {
          try {
            window.ccsmPty?.clipboard?.writeText(sel);
          } catch {
            /* ignore */
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
  } catch (e) {
    warn('shell', 'attachCustomKeyEventHandler failed', e);
  }
}
