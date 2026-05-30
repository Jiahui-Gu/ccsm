import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export type Shell = {
  sid: string;
  /** DOM wrapper parented under the host. Owns the xterm canvases AND the
   *  per-shell mask div. Never reparented after first attach — visibility
   *  is toggled via `display` + `z-index` only. */
  wrapper: HTMLDivElement;
  /** Mask div sitting inside the wrapper. Shown during cold-start /
   *  reload-of-top, hidden otherwise. */
  mask: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  /** `pty.onData` unsubscriber. Lives for the lifetime of the shell. */
  dataUnsubscribe: () => void;
  /** Disposers for textarea-bound listeners (IME, paste, selection-copy). */
  inputDisposers: Array<() => void>;
  /** Composition state — `pty.onData` writes are buffered while true so the
   *  IME preview box doesn't jump. */
  composing: boolean;
  composingBuffer: string[];
  /** Set true after the first cold-start completes; used by the host to
   *  know whether a re-show should trigger any mask UI (it should not). */
  warmed: boolean;
  /** Set true once `term.onData → pty.input` has been wired for this shell.
   *  Used by `usePtyAttachShell` to avoid double-wiring across reload — the
   *  Terminal instance is kept across reloads so the existing disposable
   *  is still live. */
  inputWired: boolean;
  /** Pending font size to apply on next show — set when a Ctrl+wheel zoom
   *  happens while this shell is hidden. */
  pendingFontSize: number | null;
};
