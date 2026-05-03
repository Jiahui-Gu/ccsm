import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { Switch } from '../ui/Switch';
import { useTranslation } from '../../i18n/useTranslation';
import { Field } from './Field';

// Wave 0e (#297): localStorage cutover, mirrors src/stores/persist.ts (#289).
// Default ON; missing key → on. Main-process gate still reads the DB row via
// electron/prefs/notifyEnabled.ts (followup to cut that side too).
export const NOTIFY_ENABLED_KEY = 'notifyEnabled';

function loadNotifyEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(NOTIFY_ENABLED_KEY);
    if (raw == null) return true;
    return !(raw === 'false' || raw === '0');
  } catch {
    return true;
  }
}

function commitSnapshot(value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(NOTIFY_ENABLED_KEY, value ? 'true' : 'false');
  } catch (err) {
    // Quota/SecurityError: warn (mirrors persist.ts onPersistError, #289).
    console.warn('[NotificationsPane] failed to persist notifyEnabled', err);
  }
}

export function NotificationsPane() {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useState<boolean>(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setEnabled(loadNotifyEnabled());
    setHydrated(true);
  }, []);

  const onChange = (next: boolean) => {
    setEnabled(next);
    commitSnapshot(next);
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
