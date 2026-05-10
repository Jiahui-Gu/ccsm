// Task #137 / #112-T4: full UI for the pre-Ready / failure / auth overlay.
// Replaces the T3 stub. Renders for any non-Ready daemon phase so the user
// sees something instead of a black screen. Styles live in `styles.css`
// alongside the rest of @ccsm/ui (the package builds via `tsc` only, so
// CSS modules — which the spec hinted at — would not survive build; we
// follow the existing BEM-in-styles.css convention instead).
//
// Phase coverage (matches frontend-tauri DaemonPhase discriminator):
//   notSpawned / spawning / starting       → spinner + "Starting daemon..."
//   ready                                  → null (the real app takes over)
//   spawnFailed { reason, retryInMs? }     → red banner + retry countdown
//   exited { code, reason }                → red banner
//   awaitingAuth { verificationUri,        → auth panel + Open browser btn
//                  userCode, expiresAt? }
//   authFailed { reason }                  → red banner + Try again btn
//
// R-50 (Task #164): the previous top-level `tunnelConnected` /
// `tunnelDisconnected` cases were removed. Tunnel state is now a sub-state
// of `ready` (see types.ts `TunnelState`), so once the daemon is Ready the
// overlay collapses regardless of tunnel up/down — preventing the regression
// where a stderr-driven tunnel emit froze the SPA on
// "Tunnel connected, waiting…". Tunnel sub-state UI (e.g. a status-bar icon)
// is owned by the main app shell, not this overlay.
//
// The `View logs`, `Open browser`, and `Try again` buttons are wired to
// console.log only — real IPC lands in S4-T8.

import { useEffect, useState, type ReactNode } from 'react';

export type DaemonStatusVariant = 'info' | 'error' | 'auth';

// Loose phase shape: we only read the discriminator + a handful of optional
// fields, keeping this independent from the shell's full DaemonPhase union
// so @ccsm/ui doesn't pull in shell types.
export interface DaemonStatusPhase {
  phase: string;
  reason?: string;
  // Mirrors `exited.code: Option<i32>` Rust wire shape (null = absent).
  code?: number | null;
  // Mirrors the Rust `Option<u64>` wire shape on `spawnFailed.retryInMs`,
  // which serializes to JSON `null` when absent. Frontend-tauri's
  // DaemonPhase['spawnFailed'] declares `retryInMs: number | null`, so this
  // prop type accepts both `null` (wire absent) and `undefined` (other phases
  // that omit the field entirely).
  retryInMs?: number | null;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: number;
}

export interface DaemonStatusOverlayProps {
  phase: DaemonStatusPhase;
  /**
   * Optional override. When omitted the variant is inferred from
   * phase.phase (failure phases → 'error', awaitingAuth → 'auth',
   * everything else → 'info').
   */
  variant?: DaemonStatusVariant;
}

function inferVariant(phase: string): DaemonStatusVariant {
  switch (phase) {
    case 'spawnFailed':
    case 'exited':
    case 'authFailed':
      return 'error';
    case 'awaitingAuth':
      return 'auth';
    default:
      return 'info';
  }
}

function Spinner(): ReactNode {
  return (
    <span
      className="daemon-overlay__spinner"
      data-testid="daemon-status-overlay-spinner"
      aria-hidden="true"
    />
  );
}

interface RetryCountdownProps {
  retryInMs: number;
}

/**
 * Local ticking countdown. We snapshot retryInMs once on mount and tick
 * it down every second; the parent prop is treated as the initial value
 * so re-renders driven by other state don't reset the clock.
 */
function RetryCountdown({ retryInMs }: RetryCountdownProps): ReactNode {
  const [remaining, setRemaining] = useState(retryInMs);
  useEffect(() => {
    setRemaining(retryInMs);
  }, [retryInMs]);
  useEffect(() => {
    if (remaining <= 0) return;
    const t = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [remaining]);
  const seconds = Math.ceil(remaining / 1000);
  if (seconds <= 0) {
    return (
      <span
        className="daemon-overlay__retry"
        data-testid="daemon-status-overlay-retry"
      >
        Retrying now…
      </span>
    );
  }
  return (
    <span
      className="daemon-overlay__retry"
      data-testid="daemon-status-overlay-retry"
    >
      Retrying in {seconds}s…
    </span>
  );
}

function StartingBody({ message }: { message: string }): ReactNode {
  return (
    <div
      className="daemon-overlay__row"
      data-testid="daemon-status-overlay-loading"
    >
      <Spinner />
      <span className="daemon-overlay__message">{message}</span>
    </div>
  );
}

interface ErrorBannerProps {
  title: string;
  detail?: string;
  retryInMs?: number;
  actionLabel: string;
  onAction: () => void;
  actionTestId: string;
}

function ErrorBanner(props: ErrorBannerProps): ReactNode {
  const { title, detail, retryInMs, actionLabel, onAction, actionTestId } =
    props;
  return (
    <div
      className="daemon-overlay__banner daemon-overlay__banner--error"
      role="alert"
      data-testid="daemon-status-overlay-banner"
    >
      <h2 className="daemon-overlay__title">{title}</h2>
      {detail !== undefined && detail !== '' ? (
        <p
          className="daemon-overlay__detail"
          data-testid="daemon-status-overlay-detail"
        >
          {detail}
        </p>
      ) : null}
      {typeof retryInMs === 'number' && retryInMs > 0 ? (
        <RetryCountdown retryInMs={retryInMs} />
      ) : null}
      <div className="daemon-overlay__actions">
        <button
          type="button"
          className="daemon-overlay__btn"
          onClick={onAction}
          data-testid={actionTestId}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

interface AuthPanelProps {
  verificationUri: string;
  userCode: string;
  expiresAt?: number;
}

function AuthPanel({
  verificationUri,
  userCode,
  expiresAt,
}: AuthPanelProps): ReactNode {
  const expiresText =
    typeof expiresAt === 'number' && expiresAt > Date.now()
      ? `Code expires in ${Math.max(
          1,
          Math.floor((expiresAt - Date.now()) / 60_000),
        )} min`
      : null;
  return (
    <div
      className="daemon-overlay__banner daemon-overlay__banner--auth"
      role="dialog"
      aria-label="Sign in with GitHub"
      data-testid="daemon-status-overlay-auth"
    >
      <h2 className="daemon-overlay__title">Sign in with GitHub</h2>
      <p className="daemon-overlay__detail">
        Visit{' '}
        <span
          className="daemon-overlay__uri"
          data-testid="daemon-status-overlay-uri"
        >
          {verificationUri}
        </span>{' '}
        and enter the code below.
      </p>
      <div
        className="daemon-overlay__user-code"
        data-testid="daemon-status-overlay-user-code"
      >
        {userCode}
      </div>
      {expiresText !== null ? (
        <p className="daemon-overlay__hint">{expiresText}</p>
      ) : null}
      <div className="daemon-overlay__actions">
        <button
          type="button"
          className="daemon-overlay__btn"
          onClick={() => {
            // Real shell.open lands in S4-T8; logging is a placeholder so
            // the click is observable in the dev console + by tests.
            // eslint-disable-next-line no-console
            console.log(
              '[DaemonStatusOverlay] open browser:',
              verificationUri,
            );
          }}
          data-testid="daemon-status-overlay-open-browser"
        >
          Open browser
        </button>
      </div>
    </div>
  );
}

export function DaemonStatusOverlay({
  phase,
  variant,
}: DaemonStatusOverlayProps): ReactNode {
  // Ready is owned by the real app — overlay must collapse out of the way.
  if (phase.phase === 'ready') {
    return null;
  }

  const resolvedVariant: DaemonStatusVariant = variant ?? inferVariant(phase.phase);

  let body: ReactNode;
  switch (phase.phase) {
    case 'notSpawned':
    case 'spawning':
    case 'starting':
      body = <StartingBody message="Starting daemon…" />;
      break;
    case 'spawnFailed':
      body = (
        <ErrorBanner
          title="Daemon failed to start"
          detail={phase.reason ?? 'Unknown error.'}
          {...(typeof phase.retryInMs === 'number'
            ? { retryInMs: phase.retryInMs }
            : {})}
          actionLabel="View logs"
          actionTestId="daemon-status-overlay-view-logs"
          onAction={() => {
            // eslint-disable-next-line no-console
            console.log('[DaemonStatusOverlay] view logs (spawnFailed)');
          }}
        />
      );
      break;
    case 'exited': {
      const codeText =
        typeof phase.code === 'number' ? ` (code ${phase.code})` : '';
      body = (
        <ErrorBanner
          title={`Daemon exited${codeText}`}
          detail={phase.reason ?? 'Process terminated unexpectedly.'}
          actionLabel="View logs"
          actionTestId="daemon-status-overlay-view-logs"
          onAction={() => {
            // eslint-disable-next-line no-console
            console.log('[DaemonStatusOverlay] view logs (exited)');
          }}
        />
      );
      break;
    }
    case 'awaitingAuth':
      body = (
        <AuthPanel
          verificationUri={phase.verificationUri ?? ''}
          userCode={phase.userCode ?? ''}
          {...(typeof phase.expiresAt === 'number'
            ? { expiresAt: phase.expiresAt }
            : {})}
        />
      );
      break;
    case 'authFailed':
      body = (
        <ErrorBanner
          title="Sign-in failed"
          detail={phase.reason ?? 'Authentication did not complete.'}
          actionLabel="Try again"
          actionTestId="daemon-status-overlay-try-again"
          onAction={() => {
            // eslint-disable-next-line no-console
            console.log('[DaemonStatusOverlay] try again (authFailed)');
          }}
        />
      );
      break;
    default:
      // Unknown phase — surface it instead of going blank, so an out-of-sync
      // shell/daemon is debuggable in the wild.
      body = <StartingBody message={`Phase: ${phase.phase}`} />;
      break;
  }

  return (
    <div
      className={`daemon-overlay daemon-overlay--${resolvedVariant}`}
      data-testid="daemon-status-overlay"
      data-variant={resolvedVariant}
      data-phase={phase.phase}
      role="status"
      aria-live="polite"
    >
      <div className="daemon-overlay__inner">
        <div className="daemon-overlay__brand">ccsm</div>
        {body}
      </div>
    </div>
  );
}
