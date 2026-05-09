// S4-T8 (Task #141): Login button + device-flow modal for the Tauri shell.
//
// Renders one of three states:
//   - logged out: "Login with GitHub" button
//   - awaiting user: modal showing user_code + "Open browser" link
//   - logged in: "@{login}" + "Logout" affordance
//
// The Rust side (auth.rs) owns the underlying flow. We:
//   1. on mount: invoke get_oauth_login to pick up an existing session
//   2. on click "Login": invoke start_oauth → display modal with user_code +
//      verification URI; open the URI in the default browser via plugin-shell.
//   3. listen for oauth-complete / oauth-failed events to close the modal.
//
// The JWT itself never crosses the IPC boundary — only the resolved login.

import { useCallback, useEffect, useState } from 'react';
import {
  invokeGetOauthLogin,
  invokeOauthLogout,
  invokeStartOauth,
  onOauthComplete,
  onOauthFailed,
  type StartOauthSpaPayload,
} from './oauth-state';

interface ModalState {
  payload: StartOauthSpaPayload;
  error: string | null;
}

export function LoginButton(): React.JSX.Element {
  const [login, setLogin] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);

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

  // Listen for completion / failure events from the Rust poll task.
  useEffect(() => {
    let unlistenComplete: (() => void) | undefined;
    let unlistenFailed: (() => void) | undefined;
    let cancelled = false;
    void onOauthComplete((payload) => {
      setLogin(payload.login);
      setModal(null);
      setBusy(false);
    }).then((u) => {
      if (cancelled) u();
      else unlistenComplete = u;
    });
    void onOauthFailed((payload) => {
      setModal((prev) => (prev !== null ? { ...prev, error: payload.reason } : prev));
      setBusy(false);
    }).then((u) => {
      if (cancelled) u();
      else unlistenFailed = u;
    });
    return () => {
      cancelled = true;
      unlistenComplete?.();
      unlistenFailed?.();
    };
  }, []);

  const onLoginClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Rust opens the verification URL via plugin-shell as part of
      // start_oauth — we just render the modal once the user_code is back.
      const payload = await invokeStartOauth();
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
    }
  }, [busy]);

  const onLogoutClick = useCallback(async () => {
    await invokeOauthLogout();
    setLogin(null);
  }, []);

  const onModalClose = useCallback(() => {
    setModal(null);
    setBusy(false);
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
    <>
      <button
        type="button"
        className="login-button login-button--out"
        data-testid="login-button"
        disabled={busy}
        onClick={() => void onLoginClick()}
      >
        Login with GitHub
      </button>
      {modal !== null ? (
        <DeviceFlowModal modal={modal} onClose={onModalClose} />
      ) : null}
    </>
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
