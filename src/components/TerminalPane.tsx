import { useCallback, useRef, type MouseEvent } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { usePtyAttachWarm, type PtyAttachState } from '../terminal/usePtyAttach.warm';
import { useAtBottom } from '../terminal/useAtBottom';
import { getActiveEntry } from '../terminal/xtermWarmRegistry';
import { terminalCopy, terminalPaste } from '../terminal/paste';
import { ScrollToBottomButton } from './ScrollToBottomButton';

// TerminalPane is the host shell for the per-session warm xterm view.
// The registry (`src/terminal/xtermWarmRegistry.ts`) owns the actual
// Terminal instances — this component just provides the reparent target
// host div, overlays (Error / Exit), and wires right-click
// copy/paste. Per-session warm state means switching sessions reparents
// the wrapper rather than tearing down xterm.
//
// The host div carries [data-terminal-host] and [data-active-sid={sessionId}]
// so e2e probes can locate the active terminal deterministically.

type Props = {
  sessionId: string;
  cwd: string;
};

export function TerminalPane({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  const { state, onRetry } = usePtyAttachWarm(sessionId, cwd, hostRef);
  // `atBottom` is intentionally unused — the button is always visible
  // while ready (see ScrollToBottomButton). We keep the hook subscribed
  // so the detection logic (and its tests) stays live for future use.
  const { scrollToBottom } = useAtBottom(sessionId);

  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.ccsmShell?.suppressContextMenuOnce();
      } catch {
        // best-effort
      }
      // Native CLI/terminal-emulator behaviour: right-click with selection
      // copies + clears; without selection, pastes. Routed through the
      // shared `paste` module, which operates on whichever warm entry is
      // currently active. No popover.
      const term = getActiveEntry()?.term;
      const copied = terminalCopy(term);
      if (!copied) {
        void terminalPaste(() => getActiveEntry()?.term, sessionId, 'right-click');
      }
    },
    [sessionId],
  );

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
      data-ccsm-warm-xterm
      onContextMenu={onContextMenu}
    >
      {/* The registry owns the inner wrapper(s); this host div is the
          reparent target. The registry's `ensureAndShowEntry` does the
          appendChild of its per-sid wrapper directly under the host. */}
      <div ref={hostRef} className="absolute inset-0" />
      <Overlay state={state} onRetry={onRetry} t={t} />
      {state.kind === 'ready' ? (
        <ScrollToBottomButton onClick={scrollToBottom} />
      ) : null}
    </div>
  );
}

function Overlay({
  state,
  onRetry,
  t,
}: {
  state: PtyAttachState;
  onRetry: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  // Intentionally no overlay for `state.kind === 'attaching'`: per user
  // feedback, cold attaches should leave the pane visually unchanged for
  // the brief window before the snapshot lands rather than flashing an
  // "Attaching..." placeholder. State machine still tracks 'attaching'
  // for focus/IPC guards elsewhere.
  if (state.kind === 'error') {
    // z-10 so the overlay sits above xterm's canvas layers (the canvas
    // renderer stacks its own absolutely-positioned canvases inside the
    // host div with non-zero z-index — without an explicit z here the
    // Retry button is rendered but unclickable). select-text on the
    // message so the user can highlight + Ctrl+C the error to share
    // (e.g. "spawn_failed: ... error code:267") with support.
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-black/80">
        <div className="text-red-400 max-w-md text-center break-words px-4 select-text">
          {state.message}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          Retry
        </button>
      </div>
    );
  }
  if (state.kind === 'exit') {
    // Two-tone overlay: clean exits get a neutral/dim background (user
    // typed /exit on purpose, no alarm); crashed exits keep the red
    // treatment so the user notices. Copy is locked in i18n —
    // `terminal.exitedClean` reassures, `terminal.exitedCrash` explicitly
    // disclaims ccsm involvement and points at the on-disk transcript so
    // the user knows their work is safe. z-10 + select-text rationale
    // matches the `error` overlay above.
    return (
      <div
        data-pty-exit-kind={state.exitKind}
        className={
          state.exitKind === 'crashed'
            ? 'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-black/80'
            : 'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-neutral-900/85'
        }
      >
        <div
          className={
            state.exitKind === 'crashed'
              ? 'text-state-error-text max-w-md text-center break-words px-4 select-text'
              : 'text-neutral-300 max-w-md text-center break-words px-4 select-text'
          }
        >
          {state.exitKind === 'crashed'
            ? t('terminal.exitedCrash', { detail: state.detail })
            : t('terminal.exitedClean')}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          {t('terminal.exitedRetry')}
        </button>
      </div>
    );
  }
  return null;
}

export default TerminalPane;
