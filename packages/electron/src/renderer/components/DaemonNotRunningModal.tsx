// T6.8 — Daemon cold-start blocking modal.
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 08 §6.1 (Daemon cold-start UX).
//
// Surface: a real DOM modal (`<dialog open>`) layered over the renderer
// tree when the renderer's first Hello has not succeeded within 8 s. The
// modal:
//
//   - Cannot be dismissed by Esc / click-outside (we cancel the native
//     `cancel` event). Disappears only when the connection state surfaced
//     by T6.7's `useConnection()` flips to `connected`.
//   - Carries one OS-specific troubleshooting hint (macOS launchd, Linux
//     systemd, Windows Service) per spec §6.1 bullet "per-OS instructions".
//   - Exposes a "Try again" button that calls the caller's `onRetry`. The
//     wiring at the call site routes this to T6.7's `retryNow()`, which
//     resets the backoff schedule and re-runs descriptor fetch + Hello.
//
// SRP: this file is a sink (renders DOM). It owns NO timer logic, NO
// connection state, NO retry mechanism — those are wired by the caller
// from `useConnection()` (T6.7). The 8-second cold-start budget that
// decides whether `open=true` lives in `useDaemonColdStartModal.ts`
// alongside this file. Splitting trigger-decision (decider) from render
// (sink) keeps this component trivially testable: render with `open=true`
// and any `platform`, assert text + button wiring.
//
// Constraint: T8.2 ESLint backstop bans `ipcMain` / `ipcRenderer` /
// `contextBridge`. The per-OS troubleshooting hint surfaces a copy-pasteable
// shell command inline (no link out, no IPC). That keeps the modal a pure
// render-only component — no preload bridge, no `shell.openExternal` call.
// We do NOT mount any new IPC.
//
// User-facing copy: locked by spec §6.1 (line 2325-2329). Sentence case
// ("Try again", not "TRY AGAIN"). Strings deliberately do NOT mention
// internals: no "UDS", no "boot_id", no "Hello RPC", no "descriptor". The
// per-OS hint surfaces the user-runnable diagnostic command from spec
// §6.1 bullet 2 verbatim.

import * as React from 'react';

/**
 * The platform detector return values used by the modal. Values are the
 * `process.platform` Node.js values surfaced through the renderer (Electron
 * exposes `process.platform` even with `nodeIntegration:false` — T6.6 boot
 * wiring confirms this is available without IPC).
 *
 * Other platform strings (`'aix'`, `'freebsd'`, `'openbsd'`, `'sunos'`,
 * etc.) fall through to the generic hint — same 8-s symptom, but the
 * spec §6.1 service-management commands are macOS / Linux / Windows only.
 */
export type DaemonModalPlatform =
  | 'darwin'
  | 'linux'
  | 'win32'
  | 'other';

/** Public props. */
export interface DaemonNotRunningModalProps {
  /**
   * When true, the dialog is rendered with the `open` attribute and is
   * visible. When false, the underlying `<dialog>` is unmounted entirely
   * (we do not lean on browser modal stacking — Electron's renderer is a
   * single user-facing dialog at a time).
   */
  readonly open: boolean;
  /**
   * Click handler for the "Try again" button. The caller wires this to
   * T6.7's `useConnection().retryNow`. The component does not call
   * preventDefault — caller decides if it wants to disable the button
   * during an in-flight attempt by passing `retryDisabled`.
   */
  readonly onRetry: () => void;
  /**
   * Platform string. Defaults to detecting via `process.platform`. Tests
   * inject explicit values; production callers omit and let detection
   * pick the user's OS.
   */
  readonly platform?: DaemonModalPlatform;
  /**
   * Disable the "Try again" button (e.g., while the caller is still
   * inside the previous attempt's await chain). Default: false.
   */
  readonly retryDisabled?: boolean;
}

/**
 * Detect the renderer's host OS. Pure function; safe to call during
 * render (no I/O, no allocation beyond the string compare).
 *
 * `process.platform` is exposed on the renderer's `process` global by
 * Electron even when `nodeIntegration` is off — same path the existing
 * preload-free renderer uses for `process.versions.electron`.
 */
export function detectPlatform(): DaemonModalPlatform {
  // Guard: in a pure-Node unit test (vitest `node` env without happy-dom
  // shim) `process` is the Node process. In happy-dom + Electron renderer
  // it's the same global. Either way, `process.platform` is the truth.
  const proc = (globalThis as { process?: { platform?: string } }).process;
  const p = proc?.platform;
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'win32';
  return 'other';
}

/**
 * Per-OS hint copy. Values are EXACT user-runnable commands from spec
 * §6.1 bullet 2; do not paraphrase — operators may copy-paste these into
 * a terminal during a support call.
 */
function platformHint(platform: DaemonModalPlatform): {
  readonly label: string;
  readonly command: string;
  readonly description: string;
} {
  switch (platform) {
    case 'darwin':
      return {
        label: 'macOS',
        command: 'launchctl print system/com.ccsm.daemon',
        description:
          'Open Terminal and run the command above to check the ccsm service status.',
      };
    case 'linux':
      return {
        label: 'Linux',
        command: 'systemctl status ccsm',
        description:
          'Open a terminal and run the command above to check the ccsm service status.',
      };
    case 'win32':
      return {
        label: 'Windows',
        command: 'Get-Service ccsm',
        description:
          'Open PowerShell and run the command above to check the ccsm service status.',
      };
    case 'other':
    default:
      return {
        label: 'Service status',
        command: '',
        description:
          'Check that the ccsm background service is installed and running on your system.',
      };
  }
}

/**
 * Blocking modal shown when the daemon has not responded within the
 * cold-start budget. See file header.
 *
 * The dialog renders nothing when `open` is false — keeps the DOM clean
 * for screen readers and avoids any chance of focus-trap leak when the
 * connection is healthy.
 */
export function DaemonNotRunningModal(
  props: DaemonNotRunningModalProps,
): React.ReactElement | null {
  const platform = props.platform ?? detectPlatform();
  const hint = platformHint(platform);
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);

  // Cancel the native dialog "cancel" event so Esc does not dismiss the
  // modal. Per spec §6.1: "The modal is dismissible only by a successful
  // Hello." Click-outside on a non-modal `<dialog open>` is already a
  // no-op (only `showModal()` adds the backdrop + click-outside dismiss
  // path); we deliberately use the `open` attribute path, NOT
  // `showModal()`, so our render is the single source of truth and there
  // is no imperative state to keep in sync.
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const onCancel = (event: Event): void => {
      event.preventDefault();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
    };
  }, [props.open]);

  if (!props.open) return null;

  return (
    <dialog
      ref={dialogRef}
      open
      role="alertdialog"
      aria-labelledby="ccsm-daemon-not-running-title"
      aria-describedby="ccsm-daemon-not-running-body"
      data-testid="daemon-not-running-modal"
    >
      <h2 id="ccsm-daemon-not-running-title">ccsm daemon is not running.</h2>
      <p id="ccsm-daemon-not-running-body">
        The ccsm background service did not respond after 8 seconds. The
        renderer will keep retrying in the background.
      </p>
      <section
        aria-label="Service troubleshooting"
        data-testid="daemon-modal-troubleshooting"
      >
        <h3>{hint.label}</h3>
        <p>{hint.description}</p>
        {hint.command !== '' ? (
          <pre data-testid="daemon-modal-command">
            <code>{hint.command}</code>
          </pre>
        ) : null}
      </section>
      <div data-testid="daemon-modal-actions">
        <button
          type="button"
          onClick={props.onRetry}
          disabled={props.retryDisabled === true}
          data-testid="daemon-modal-retry"
          autoFocus
        >
          Try again
        </button>
      </div>
    </dialog>
  );
}
