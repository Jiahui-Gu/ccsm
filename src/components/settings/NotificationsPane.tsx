import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { Switch } from '../ui/Switch';
import { useTranslation } from '../../i18n/useTranslation';
import { Field } from './Field';

// Desktop notifications mute toggle. Persisted via the existing
// `db:save` / `db:load` IPC under the `notifyEnabled` app_state key — main
// reads the same key on every sessionWatcher state event so the toggle
// takes effect without a restart. Default is ON: a missing row means
// notifications fire (the "fresh install ships with toasts on" experience).
export function NotificationsPane() {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useState<boolean>(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await window.ccsm?.loadState('notifyEnabled');
        if (cancelled) return;
        // Missing row → default ON. Explicit 'false' / '0' → off.
        if (raw == null) setEnabled(true);
        else setEnabled(!(raw === 'false' || raw === '0'));
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = (next: boolean) => {
    setEnabled(next);
    void window.ccsm?.saveState('notifyEnabled', next ? 'true' : 'false');
  };

  return (
    <div data-notifications-pane>
      <div className="text-meta text-fg-tertiary mb-4 max-w-[520px]">
        {t('notifications.intro')}
      </div>
      <Field label={t('notifications.enable')}>
        <label
          className={cn(
            'inline-flex items-center gap-2 cursor-pointer select-none',
            !hydrated && 'opacity-60'
          )}
        >
          <Switch
            checked={enabled}
            disabled={!hydrated}
            onCheckedChange={onChange}
            aria-label={t('notifications.enable')}
            data-notify-enable-toggle
          />
          <span className="text-chrome text-fg-secondary">
            {t('notifications.enable')}
          </span>
        </label>
      </Field>
    </div>
  );
}
