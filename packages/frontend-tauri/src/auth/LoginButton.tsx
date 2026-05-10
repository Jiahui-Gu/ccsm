// S4-T8 (Task #141): Login button + device-flow modal for the Tauri shell.
// R-51c (Task #169): PKCE-first UX with collapsible device-flow fallback.
//
// Renders one of these states:
//   - logged out:
//       Primary: "Sign in with GitHub" (PKCE / deep-link).
//       Below:   "Trouble signing in? Use a code instead" — collapsed link.
//                Expanding it reveals the device-flow trigger button which,
//                when clicked, runs start_device_oauth and surfaces the
//                user_code modal as before.
//       Auto-expand: 5 s after the PKCE button is pressed without an
//       `oauth-complete` arriving, the fallback row expands itself so the
//       user sees the alternative without having to read the small grey link.
//   - awaiting user (device flow only): modal showing user_code +
//                                        "Open browser" link
//   - logged in: "@{login}" + "Logout" affordance
//
// The Rust side (auth.rs) owns the underlying flow. We:
//   1. on mount: invoke get_oauth_login to pick up an existing session
//   2. on click "Sign in" (PKCE): invoke start_pkce_oauth — Rust opens the
//      browser, the OS hands back a `ccsm://oauth?...` deep link, the Rust
//      side persists creds and emits `oauth-complete`.
//   3. on click "Use a code instead" (device): invoke start_device_oauth →
//      display modal with user_code + verification URI; Rust polls and
//      emits `oauth-complete` / `oauth-failed`.
//   4. listen for oauth-complete / oauth-failed events to close the modal.
//
// The JWT itself never crosses the IPC boundary — only the resolved login.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  invokeGetOauthLogin,
  invokeOauthLogout,
  invokeStartDeviceOauth,
  invokeStartPkceOauth,
  onOauthComplete,
  onOauthFailed,
  type StartOauthSpaPayload,
} from './oauth-state';

interface ModalState {
  payload: StartOauthSpaPayload;
  error: string | null;
}

/// R-51c (Task #169): how long after pressing "Sign in with GitHub" we wait
/// before auto-expanding the fallback row. Picked at 5 s based on the spec —
/// long enough for the OS to launch the browser and for the user to see the
/// authorize page, short enough that a stuck deep-link registration surfaces
/// the alternative quickly.
export const PKCE_AUTOFALLBACK_MS = 5_000;

export function LoginButton(): React.JSX.Element {
  const [login, setLogin] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);
  // R-51c: which path is currently in flight, for both pkce-vs-device
  // dispatch in the UI and so we can cancel the auto-fallback timer if
  // the PKCE path resolves first. We use a ref (not state) because the
  // value is only consulted from event handlers (oauth-failed routing) —
  // it never affects rendering, so a re-render on every transition would
  // be wasted work.
  const activeFlowRef = useRef<'pkce' | 'device' | null>(null);
  // R-51c: whether the "Trouble?" row is expanded. Clicking the link toggles
  // it manually; the 5 s auto-fallback timer expands it implicitly.
  const [fallbackOpen, setFallbackOpen] = useState(false);
  // R-51c: surface PKCE start errors (e.g. cf-worker 5xx) inline. Device
  // flow errors continue to land inside the modal alongside the user_code.
  const [pkceError, setPkceError] = useState<string | null>(null);

  const autoFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAutoFallback = useCallback(() => {
    if (autoFallbackTimer.current !== null) {
      clearTimeout(autoFallbackTimer.current);
      autoFallbackTimer.current = null;
    }
  }, []);

  // Initial pick-up of any persisted login.
  useEffect(() => {
    let cancelled = false;
    void invokeGetOauthLogin().then((l) => {
      if (!cancelled) setLogin(l);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for completion / failure events from the Rust poll task or the
  // deep-link callback. Both PKCE and device-flow paths funnel through the
  // same `oauth-complete` / `oauth-failed` channels (R-51b auth.rs).
  useEffect(() => {
    let unlistenComplete: (() => void) | undefined;
    let unlistenFailed: (() => void) | undefined;
    let cancelled = false;
    void onOauthComplete((payload) => {
      setLogin(payload.login);
      setModal(null);
      setBusy(false);
      activeFlowRef.current = null;
      setPkceError(null);
      clearAutoFallback();
    }).then((u) => {
      if (cancelled) u();
      else unlistenComplete = u;
    });
    void onOauthFailed((payload) => {
      // R-51c: route the failure to the path that triggered it.
      const flow = activeFlowRef.current;
      if (flow === 'pkce') {
        setPkceError(payload.reason);
        // Auto-expand fallback so the user has an immediate next step.
        setFallbackOpen(true);
      } else {
        setModal((prev) => (prev !== null ? { ...prev, error: payload.reason } : prev));
      }
      activeFlowRef.current = null;
      setBusy(false);
      clearAutoFallback();
    }).then((u) => {
      if (cancelled) u();
      else unlistenFailed = u;
    });
    return () => {
      cancelled = true;
      unlistenComplete?.();
      unlistenFailed?.();
    };
  }, [clearAutoFallback]);

  // Cleanup on unmount: don't leak timers across re-renders.
  useEffect(() => clearAutoFallback, [clearAutoFallback]);

  const onPkceClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    activeFlowRef.current = 'pkce';
    setPkceError(null);
    // Schedule the 5 s auto-expand; cancelled if oauth-complete or
    // oauth-failed arrives first.
    clearAutoFallback();
    autoFallbackTimer.current = setTimeout(() => {
      setFallbackOpen(true);
      autoFallbackTimer.current = null;
    }, PKCE_AUTOFALLBACK_MS);
    try {
      await invokeStartPkceOauth();
      // start_pkce_oauth returns once the browser has been launched. The SPA
      // now waits for the deep-link round-trip; oauth-complete / oauth-failed
      // listeners (above) handle resolution.
    } catch (err) {
      // cf-worker returned non-2xx, env not set, etc. — surface inline,
      // expand fallback so the user is unblocked.
      setPkceError(String(err));
      setFallbackOpen(true);
      setBusy(false);
      activeFlowRef.current = null;
      clearAutoFallback();
    }
  }, [busy, clearAutoFallback]);

  const onDeviceClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    activeFlowRef.current = 'device';
    clearAutoFallback();
    try {
      const payload = await invokeStartDeviceOauth();
      setModal({ payload, error: null });
    } catch (err) {
      setModal({
        payload: {
          user_code: '',
          verification_uri: '',
          expires_in: 0,
          interval: 0,
        },
        error: String(err),
      });
      setBusy(false);
      activeFlowRef.current = null;
    }
  }, [busy, clearAutoFallback]);

  const onLogoutClick = useCallback(async () => {
    await invokeOauthLogout();
    setLogin(null);
  }, []);

  const onModalClose = useCallback(() => {
    setModal(null);
    setBusy(false);
    activeFlowRef.current = null;
  }, []);

  const onToggleFallback = useCallback(() => {
    setFallbackOpen((open) => !open);
  }, []);

  if (login !== null) {
    return (
      <div className="login-button login-button--in" data-testid="login-button">
        <span className="login-button__user">@{login}</span>
        <button
          type="button"
          className="login-button__logout"
          onClick={() => void onLogoutClick()}
        >
          Logout
        </button>
      </div>
    );
  }

  return (
    <div className="login-button login-button--out" data-testid="login-button">
      <button
        type="button"
        className="login-button__primary"
        data-testid="login-button-pkce"
        disabled={busy}
        onClick={() => void onPkceClick()}
      >
        Sign in with GitHub
      </button>
      {pkceError !== null ? (
        <p className="login-button__error" data-testid="login-button-pkce-error">
          Sign-in failed: {pkceError}
        </p>
      ) : null}
      <div className="login-button__fallback">
        <button
          type="button"
          className="login-button__fallback-toggle"
          data-testid="login-button-fallback-toggle"
          aria-expanded={fallbackOpen}
          onClick={onToggleFallback}
        >
          {fallbackOpen ? 'Hide code option' : 'Trouble signing in? Use a code instead'}
        </button>
        {fallbackOpen ? (
          <div className="login-button__fallback-body" data-testid="login-button-fallback-body">
            <p className="login-button__fallback-hint">
              If the browser sign-in didn&apos;t come back to ccsm, you can finish
              authorizing with a one-time code instead.
            </p>
            <button
              type="button"
              className="login-button__device"
              data-testid="login-button-device"
              disabled={busy}
              onClick={() => void onDeviceClick()}
            >
              Use a code
            </button>
          </div>
        ) : null}
      </div>
      {modal !== null ? (
        <DeviceFlowModal modal={modal} onClose={onModalClose} />
      ) : null}
    </div>
  );
}

interface DeviceFlowModalProps {
  modal: ModalState;
  onClose: () => void;
}

function DeviceFlowModal({ modal, onClose }: DeviceFlowModalProps): React.JSX.Element {
  const { payload, error } = modal;
  return (
    <div className="oauth-modal__backdrop" role="dialog" aria-modal="true" data-testid="oauth-modal">
      <div className="oauth-modal__panel">
        <h2 className="oauth-modal__title">Authorize ccsm</h2>
        {error !== null ? (
          <>
            <p className="oauth-modal__error">Login failed: {error}</p>
            <button type="button" onClick={onClose}>Close</button>
          </>
        ) : (
          <>
            <p>
              Your browser should have opened. If not, visit:
            </p>
            <p>
              <a
                href={payload.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
              >
                {payload.verification_uri}
              </a>
            </p>
            <p>Enter this code:</p>
            <p className="oauth-modal__code" data-testid="oauth-user-code">
              {payload.user_code}
            </p>
            <button type="button" onClick={onClose}>Cancel</button>
          </>
        )}
      </div>
    </div>
  );
}
