import { useCallback, useRef, type MouseEvent } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { useXtermSingleton } from '../terminal/useXtermSingleton';
import { useTerminalResize } from '../terminal/useTerminalResize';
import { usePtyAttach, type PtyAttachState } from '../terminal/usePtyAttach';
import { usePtyAttachWarm } from '../terminal/usePtyAttach.warm';
import { useAtBottom } from '../terminal/useAtBottom';
import { terminalCopy, terminalPaste } from '../terminal/xtermSingleton';
import { ScrollToBottomButton } from './ScrollToBottomButton';

// PR #25 (per-session warm xterm) — read the feature-flag snapshot from
// the preload bridge ONCE at module load. The flag is sourced from
// `CCSM_WARM_XTERM=1` in `electron/preload/bridges/ccsmCore.ts`. Static
// boolean — no re-reads, no runtime toggling. When false (the default),
// the singleton + legacy attach path runs bit-identical to today.
//
// Reading at module load (not at component render) keeps the hook
// selection stable across re-renders, which React requires (hooks-rules:
// "called in the same order every render"). A useState toggle from a
// future settings UI is intentionally NOT supported in this PR — the
// rollout shape is env-var-only, follow-up PR flips the default.
const WARM_XTERM_ENABLED: boolean = (() => {
  try {
    if (typeof window === 'undefined') return false;
    return window.ccsm?.featureFlags?.warmXterm === true;
  } catch {
    return false;
  }
})();

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
  // Hook selection is decided at module-load time (see WARM_XTERM_ENABLED
  // above) and never changes for the renderer's lifetime, so this
  // conditional branch is React-hooks-rules compliant: each branch
  // contains a stable, ordered set of hook calls.
  return WARM_XTERM_ENABLED ? (
    <TerminalPaneWarm sessionId={sessionId} cwd={cwd} />
  ) : (
    <TerminalPaneLegacy sessionId={sessionId} cwd={cwd} />
  );
}

function TerminalPaneLegacy({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  useXtermSingleton(hostRef);
  useTerminalResize(hostRef);
  const { state, onRetry } = usePtyAttach(sessionId, cwd);
  // `atBottom` is intentionally unused — the button is always visible while
  // ready (see ScrollToBottomButton). We keep the hook subscribed so the
  // detection logic (and its tests) stay live for future use.
  const { scrollToBottom } = useAtBottom(sessionId);

  const onContextMenu = useCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.ccsmShell?.suppressContextMenuOnce();
    } catch {
      // best-effort
    }
    const copied = terminalCopy();
    if (!copied) terminalPaste();
  }, []);

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
      onContextMenu={onContextMenu}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <Overlay state={state} onRetry={onRetry} t={t} />
      {state.kind === 'ready' ? (
        <ScrollToBottomButton onClick={scrollToBottom} />
      ) : null}
    </div>
  );
}

// PR #25 — warm-xterm variant. The registry owns the xterm Terminal (one
// per sid), so the host div is just a reparent target, NOT the parent of
// a singleton xterm. `useXtermSingleton` and `useTerminalResize` are
// intentionally NOT used here — the registry installs its own xterm
// instances and the warm hook calls `entry.fit.fit()` on attach.
//
// `terminalCopy`/`terminalPaste` from the legacy singleton are STILL
// imported and bound to right-click — they operate on the legacy module's
// state, which is unused in this branch. That means right-click
// copy/paste is broken in the warm path for this initial PR. Follow-up:
// either route the right-click handler through the registry's active
// entry, or move the canonical paste path into a shared module both
// branches consume. Out-of-scope for the empirical-flash-elimination
// dogfood validation this PR is shipping.
function TerminalPaneWarm({ sessionId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { t } = useTranslation();

  const { state, onRetry } = usePtyAttachWarm(sessionId, cwd, hostRef);
  const { scrollToBottom } = useAtBottom(sessionId);

  const onContextMenu = useCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.ccsmShell?.suppressContextMenuOnce();
    } catch {
      // best-effort
    }
    // Legacy singleton-bound copy/paste — see note above. No-op against
    // the warm registry. Falls through to native menu suppression which
    // is the user-visible behaviour the legacy path also relied on.
    const copied = terminalCopy();
    if (!copied) terminalPaste();
  }, []);

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
      data-ccsm-warm-xterm
      onContextMenu={onContextMenu}
    >
      {/* The registry owns the inner wrapper(s); this host div is the
          reparent target. No `<div ref={hostRef}>` because the registry
          appendChild()s its per-sid wrapper directly under the host. */}
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
