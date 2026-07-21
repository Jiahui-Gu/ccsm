import React, { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { MobileRemoteStatus } from '../../global';
import { useTranslation } from '../../i18n/useTranslation';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';

type StatusCopy = {
  badge: string;
  desktop: string;
  phone: string;
  detail?: string;
  tone: 'ready' | 'pending' | 'error';
};

export function MobileRemotePane() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<MobileRemoteStatus>({ kind: 'connecting' });
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetchPairingUrl = useCallback(async () => {
    const url = await window.ccsmMobileRemote?.getPairingUrl();
    setPairingUrl(url ?? null);
  }, []);

  useEffect(() => {
    let mounted = true;
    let receivedStatusEvent = false;
    const bridge = window.ccsmMobileRemote;
    if (!bridge) {
      setStatus({ kind: 'unavailable', reason: 'relay-not-configured' });
      return;
    }

    const applyStatus = (next: MobileRemoteStatus) => {
      if (!mounted) return;
      setStatus(next);
    };
    const unsubscribe = bridge.onStatus((next) => {
      receivedStatusEvent = true;
      applyStatus(next);
    });
    void fetchPairingUrl();
    void bridge.getStatus().then((initialStatus) => {
      if (!receivedStatusEvent) applyStatus(initialStatus);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [fetchPairingUrl]);

  const statusCopy = getStatusCopy(status, t);
  const canPair =
    (status.kind === 'ready' || status.kind === 'connecting') && pairingUrl !== null;

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  function rotatePairing() {
    const bridge = window.ccsmMobileRemote;
    if (!bridge) return;
    void runAction(async () => {
      await bridge.rotate();
      await fetchPairingUrl();
    });
  }

  return (
    <div data-mobile-remote-pane>
      <h2 className="text-md font-semibold text-fg-primary">{t('mobileRemote.title')}</h2>
      <p className="mt-1 max-w-[520px] text-meta text-fg-tertiary">{t('mobileRemote.intro')}</p>

      <div className="mt-4 flex items-center justify-between rounded-md border border-border-default p-3">
        <div className="text-chrome font-medium text-fg-primary">{t('mobileRemote.relay')}</div>
        <span
          role="status"
          className={`rounded-full px-2 py-0.5 text-meta font-medium ${toneClass[statusCopy.tone]}`}
        >
          {statusCopy.badge}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <ConnectionState label={t('mobileRemote.desktop')} value={statusCopy.desktop} />
        <ConnectionState label={t('mobileRemote.phone')} value={statusCopy.phone} />
      </div>

      {statusCopy.detail && (
        <div className="mt-3 rounded-md border border-border-default bg-bg-elevated p-3 text-meta text-fg-secondary">
          {statusCopy.detail}
        </div>
      )}

      {canPair && (
        <div className="mt-5 flex flex-col items-center">
          <h3 className="text-chrome font-medium text-fg-primary">{t('mobileRemote.pairTitle')}</h3>
          <p className="mt-1 text-center text-meta text-fg-tertiary">{t('mobileRemote.pairHint')}</p>
          <div
            role="img"
            aria-label={t('mobileRemote.qrAria')}
            className="mt-3 rounded-lg bg-white p-3 text-black"
          >
            <QRCodeSVG
              value={pairingUrl}
              size={176}
              level="M"
              title={t('mobileRemote.qrAria')}
            />
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {status.kind === 'paused' ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void runAction(() => window.ccsmMobileRemote?.resume() ?? Promise.resolve())}
          >
            {t('mobileRemote.resume')}
          </Button>
        ) : (
          (status.kind === 'ready' || status.kind === 'connecting') && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void runAction(() => window.ccsmMobileRemote?.pause() ?? Promise.resolve())}
            >
              {t('mobileRemote.pause')}
            </Button>
          )
        )}
        {status.kind === 'ready' && (
          <Button variant="secondary" disabled={busy} onClick={() => setConfirmRotate(true)}>
            {t('mobileRemote.refreshQr')}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={t('mobileRemote.rotateTitle')}
        description={t('mobileRemote.rotateDescription')}
        confirmLabel={t('mobileRemote.rotateConfirm')}
        cancelLabel={t('mobileRemote.rotateCancel')}
        destructive
        onConfirm={rotatePairing}
      />
    </div>
  );
}

function ConnectionState({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle p-3">
      <div className="text-meta text-fg-tertiary">{label}</div>
      <div className="mt-1 text-chrome text-fg-primary">{value}</div>
    </div>
  );
}

const toneClass: Record<StatusCopy['tone'], string> = {
  ready: 'bg-state-success-bg text-state-success-fg',
  pending: 'bg-state-warning-bg text-state-warning-fg',
  error: 'bg-state-error-bg text-state-error-fg'
};

function getStatusCopy(
  status: MobileRemoteStatus,
  t: (key: string) => string
): StatusCopy {
  if (status.kind === 'connecting') {
    return {
      badge: t('mobileRemote.connecting'),
      desktop: t('mobileRemote.desktopConnecting'),
      phone: t('mobileRemote.phoneWaiting'),
      tone: 'pending'
    };
  }
  if (status.kind === 'ready') {
    return {
      badge: t('mobileRemote.ready'),
      desktop: t('mobileRemote.desktopConnected'),
      phone: status.phoneConnected
        ? t('mobileRemote.phoneConnected')
        : t('mobileRemote.phoneWaiting'),
      tone: 'ready'
    };
  }
  if (status.kind === 'paused') {
    return {
      badge: t('mobileRemote.paused'),
      desktop: t('mobileRemote.desktopPaused'),
      phone: t('mobileRemote.phonePaused'),
      tone: 'pending'
    };
  }
  if (status.kind === 'unavailable') {
    const secureStorage = status.reason === 'secure-storage-unavailable';
    return {
      badge: t(
        secureStorage
          ? 'mobileRemote.secureStorageUnavailable'
          : 'mobileRemote.relayUnavailable'
      ),
      desktop: t('mobileRemote.desktopUnavailable'),
      phone: t('mobileRemote.phoneUnavailable'),
      detail: t(
        secureStorage
          ? 'mobileRemote.secureStorageDetail'
          : 'mobileRemote.relayUnavailableDetail'
      ),
      tone: 'error'
    };
  }

  const errorCopy = {
    'relay-unreachable': {
      badge: 'mobileRemote.connectionError',
      detail: 'mobileRemote.connectionErrorDetail'
    },
    'protocol-mismatch': {
      badge: 'mobileRemote.updateRequired',
      detail: 'mobileRemote.updateRequiredDetail'
    },
    'authentication-failed': {
      badge: 'mobileRemote.pairingError',
      detail: 'mobileRemote.pairingErrorDetail'
    }
  } as const;
  const copy = errorCopy[status.reason];
  return {
    badge: t(copy.badge),
    desktop: t('mobileRemote.desktopError'),
    phone: t('mobileRemote.phoneUnavailable'),
    detail: t(copy.detail),
    tone: 'error'
  };
}
