import { useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { useXtermSingleton } from '../terminal/useXtermSingleton';
import { useTerminalResize } from '../terminal/useTerminalResize';
import { usePtyAttach, type PtyAttachState } from '../terminal/usePtyAttach';

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
//
// Spec #592 T-4 / Task #603 (PR-4) — host-unconditional + xterm pin order:
//   - The host div is rendered ALWAYS, even when no session is active.
//     `sessionId` is nullable; the data-active-sid attribute is set only
//     when a sid is provided. This lets the upstream `terminal-host-mounted`
//     e2e probe (#605 PR-8) latch on the host before the active session
//     resolves, avoiding the previous "blank pane → conditional mount"
//     race that #888 / #852 fallout exposed.
//   - xterm is pinned strictly AFTER the pty-host wire is in place:
//     `useXtermSingleton(hostRef, enabled)` only constructs the Terminal
//     when a sid exists AND `window.ccsmPty` is wired. The renderer never
//     boots an xterm against a half-initialised preload — this is the
//     wire-then-instantiate ordering documented in §3.1.5.

type Props = {
  /**
   * The active session id, or `null` while no session is selected.
   * Spec #592 T-4 PR-4: kept nullable so the host element can mount
   * before the session lifecycle resolves.
   */
  sessionId: string | null;
  /** Working directory for spawn-on-attach-null. Ignored when sessionId is null. */
  cwd: string;
};

export function TerminalPane({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  // xterm pin order: enable bring-up only once we have a sid. The
  // singleton hook also re-checks `window.ccsmPty` internally (the
  // pty-host wire) so the constructor never runs before the bridge.
  const xtermEnabled = sessionId != null;
  useXtermSingleton(hostRef, xtermEnabled);
  useTerminalResize(hostRef);
  const { state, onRetry } = usePtyAttach(sessionId, cwd);

  // `data-active-sid` is set only when a sid is present. e2e probes that
  // need to wait for "active terminal" should look for both attributes;
  // probes that only need the host (e.g. terminal-host-mounted, #605
  // PR-8) should match `[data-terminal-host]` alone.
  const hostProps: Record<string, string> = { 'data-terminal-host': '' };
  if (sessionId != null) {
    hostProps['data-active-sid'] = sessionId;
  }

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      {...hostProps}
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
  if (state.kind === 'idle') {
    // Host-mounted-without-sid window (spec #592 T-4 PR-4): no overlay
    // text — the empty-state copy lives in App.tsx's no-active-session
    // chrome. Returning null here keeps the host visually identical to
    // a freshly-attached pane (black background) so the transition into
    // 'attaching' is a single overlay flip rather than a layout shift.
    return null;
  }
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
