import { useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { useXtermSingleton } from '../terminal/useXtermSingleton';
import { useTerminalResize } from '../terminal/useTerminalResize';
import { usePtyAttach, type PtyAttachState } from '../terminal/usePtyAttach';
// classifyPtyExit is re-exported for backward compat with any direct
// importers; the actual exit classification now lives inside usePtyAttach.
export { classifyPtyExit } from '../lib/ptyExitClassifier';

// TerminalPane is the host shell for the singleton xterm view. The three
// concerns it used to mash together — singleton bring-up, PTY lifecycle,
// container resize — now live in dedicated hooks under src/terminal/.
// This file is the host div + ExitState/ErrorState overlays + composition
// of those three hooks. See:
//   - src/terminal/xtermSingleton.ts    (module-singleton state + ensureTerminal)
//   - src/terminal/useXtermSingleton.ts (mount-once bring-up)
//   - src/terminal/usePtyAttach.ts      (attach/detach/snapshot/subscribe + exit)
//   - src/terminal/useTerminalResize.ts (ResizeObserver + fit)
//
// The host div carries [data-terminal-host] and [data-active-sid={sessionId}]
// so the e2e probes (PR-7) can locate the active terminal deterministically.

type Props = {
  sessionId: string;
  cwd: string;
};

export function TerminalPane({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  useXtermSingleton(hostRef);
  useTerminalResize(hostRef);
  const { state, onRetry } = usePtyAttach(sessionId, cwd);

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <Overlay state={state} onRetry={onRetry} t={t} />
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
  if (state.kind === 'attaching') {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center text-neutral-400 text-sm pointer-events-none">
        Attaching...
      </div>
    );
  }
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
