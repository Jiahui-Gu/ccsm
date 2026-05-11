// Task #137 / #112-T4: daemon status UI surfaces.
// R-57 (Task #181): split out of the full-screen overlay design — SPA main
// shell now renders unconditionally, so this component only renders
// non-blocking surfaces (chip / banner / dialog) on top of the shell.
//
// Rendering modes (chosen by inferMode + `mode` prop):
//   notSpawned / spawning / starting   → 'chip'   (bottom-right pill)
//   spawnFailed / exited / authFailed  → 'banner' (top sticky bar)
//   awaitingAuth                       → 'dialog' (modal, login flow)
//   ready                              → null (no surface)
//
// Phase coverage (mirrors frontend-tauri DaemonPhase discriminator):
//   notSpawned / spawning / starting       → chip "daemon: starting"
//   ready                                  → null
//   spawnFailed { reason, retryInMs? }     → banner + retry countdown
//   exited { code, reason }                → banner
//   awaitingAuth { verificationUri,        → dialog with user_code
//                  userCode, expiresAt? }
//   authFailed { reason }                  → banner + Try again btn
//
// R-50 (Task #164): the previous top-level `tunnelConnected` /
// `tunnelDisconnected` cases were removed. Tunnel state is now a sub-state
// of `ready` (see types.ts `TunnelState`).
//
// R-57 backward-compat note: this component used to render full-screen for
// EVERY non-Ready phase, which meant the SPA was hidden behind a dark
// overlay during the 2-3 s daemon spawn window. That contradicted Task
// #112's "no daemon also has UI" design intent. We keep the existing
// testids (`daemon-status-overlay`, `daemon-status-overlay-loading`,
// `daemon-status-overlay-banner`, `daemon-status-overlay-auth`,
// `daemon-status-overlay-user-code`, etc.) so #138-derived e2e + vitest
// suites can keep asserting on them — only the layout / z-index / position
// changes.

import { useEffect, useState, type ReactNode } from 'react';

export type DaemonStatusVariant = 'info' | 'error' | 'auth';
export type DaemonStatusMode = 'chip' | 'banner' | 'dialog';

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
  /**
   * R-57: optional layout override. Omitted → inferred from phase:
   *   - loading phases → 'chip'
   *   - failure phases → 'banner'
   *   - awaitingAuth   → 'dialog'
   * Shells can force a specific mode (e.g. always-chip during dev).
   */
  mode?: DaemonStatusMode;
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

function inferMode(phase: string): DaemonStatusMode {
  switch (phase) {
    case 'spawnFailed':
    case 'exited':
    case 'authFailed':
      return 'banner';
    case 'awaitingAuth':
      return 'dialog';
    default:
      return 'chip';
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

/**
 * R-57: chip label per loading-phase. Kept terse to fit a small pill.
 */
function chipLabel(phase: string): string {
  switch (phase) {
    case 'notSpawned':
      return 'daemon: not started';
    case 'spawning':
      return 'daemon: spawning';
    case 'starting':
      return 'daemon: starting';
    default:
      return `daemon: ${phase}`;
  }
}

export function DaemonStatusOverlay({
  phase,
  variant,
  mode,
}: DaemonStatusOverlayProps): ReactNode {
  // Ready is owned by the real app — chip/banner/dialog must collapse out.
  if (phase.phase === 'ready') {
    return null;
  }

  const resolvedVariant: DaemonStatusVariant =
    variant ?? inferVariant(phase.phase);
  const resolvedMode: DaemonStatusMode = mode ?? inferMode(phase.phase);

  // --- chip: small bottom-right pill for loading phases ---
  if (resolvedMode === 'chip') {
    return (
      <div
        className={`daemon-overlay daemon-overlay--chip daemon-overlay--${resolvedVariant}`}
        data-testid="daemon-status-overlay"
        data-variant={resolvedVariant}
        data-phase={phase.phase}
        data-mode="chip"
        role="status"
        aria-live="polite"
      >
        <div
          className="daemon-overlay__row"
          data-testid="daemon-status-overlay-loading"
        >
          <Spinner />
          <span
            className="daemon-overlay__message"
            data-testid="daemon-status-overlay-chip-label"
          >
            {chipLabel(phase.phase)}
          </span>
        </div>
      </div>
    );
  }

  // --- banner: top sticky bar for failure phases ---
  if (resolvedMode === 'banner') {
    let body: ReactNode;
    switch (phase.phase) {
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
        body = <StartingBody message={`Phase: ${phase.phase}`} />;
        break;
    }
    return (
      <div
        className={`daemon-overlay daemon-overlay--banner-host daemon-overlay--${resolvedVariant}`}
        data-testid="daemon-status-overlay"
        data-variant={resolvedVariant}
        data-phase={phase.phase}
        data-mode="banner"
        role="status"
        aria-live="polite"
      >
        <div className="daemon-overlay__inner">{body}</div>
      </div>
    );
  }

  // --- dialog: modal for awaitingAuth (login flow needs full attention) ---
  // R-57: this is the ONE remaining blocking surface. User must read the
  // user_code to authorize, so a modal makes sense — but it's a real
  // <dialog>, not a full-bleed bootstrap overlay.
  let body: ReactNode;
  switch (phase.phase) {
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
    default:
      // Unknown phase routed to dialog — surface it instead of going blank.
      body = <StartingBody message={`Phase: ${phase.phase}`} />;
      break;
  }
  return (
    <div
      className={`daemon-overlay daemon-overlay--dialog daemon-overlay--${resolvedVariant}`}
      data-testid="daemon-status-overlay"
      data-variant={resolvedVariant}
      data-phase={phase.phase}
      data-mode="dialog"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
    >
      <div className="daemon-overlay__inner">
        <div className="daemon-overlay__brand">ccsm</div>
        {body}
      </div>
    </div>
  );
}
