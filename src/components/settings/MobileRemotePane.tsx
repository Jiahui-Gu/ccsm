import React, { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useTranslation } from '../../i18n/useTranslation';
import type { MobileRemoteAuthState } from '../../global';
import { Field } from './Field';

// Settings pane for the desktop side of the public-internet mobile-remote
// path (PR-4b). It drives the GitHub OAuth login flow that yields a
// mobile-remote session JWT + Durable Object URL, surfaces the current
// logged-in/out state, and lets the user disconnect. All work happens on
// main behind the `window.ccsm.mobileRemote*` bridge — this component only
// reflects and triggers it.
export function MobileRemotePane() {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<MobileRemoteAuthState>({
    loggedIn: false,
    userHash: null,
    expiresAtMs: null,
    persisted: true,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.ccsm?.mobileRemoteAuthState().then(setState).catch(() => {});
    const off = window.ccsm?.onMobileRemoteAuthState(setState);
    return () => off?.();
  }, []);

  async function onConnect() {
    if (!window.ccsm) return;
    setBusy(true);
    try {
      const next = await window.ccsm.mobileRemoteLogin();
      setState(next);
    } catch {
      // Popup cancelled / failed: main resolves to a logged-out state via the
      // push, so there's nothing to surface here beyond clearing the busy flag.
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (!window.ccsm) return;
    setBusy(true);
    try {
      const next = await window.ccsm.mobileRemoteLogout();
      setState(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-mobile-remote-pane>
      <div className="text-meta text-fg-tertiary mb-4 max-w-[520px]">
        {t('mobileRemote.intro')}
      </div>
      <Field label={t('mobileRemote.status')}>
        <span className="text-chrome text-fg-secondary">
          {state.loggedIn
            ? t('mobileRemote.statusConnected')
            : t('mobileRemote.statusDisconnected')}
        </span>
      </Field>
      {state.loggedIn && state.userHash && (
        <Field label={t('mobileRemote.account')}>
          <span className="text-chrome text-fg-secondary font-mono">{state.userHash}</span>
        </Field>
      )}
      {!state.persisted && (
        <div className="text-meta text-fg-tertiary mb-4 max-w-[520px]">
          <span className="font-medium text-fg-secondary">{t('mobileRemote.notPersisted')}</span>
          {' — '}
          {t('mobileRemote.notPersistedHint')}
        </div>
      )}
      <div className="flex gap-2">
        {state.loggedIn ? (
          <Button variant="secondary" size="md" onClick={onDisconnect} disabled={busy}>
            {t('mobileRemote.disconnectButton')}
          </Button>
        ) : (
          <Button variant="primary" size="md" onClick={onConnect} disabled={busy}>
            {busy ? t('mobileRemote.connecting') : t('mobileRemote.connectButton')}
          </Button>
        )}
      </div>
    </div>
  );
}
