import { useEffect } from 'react';
import { i18next } from '../i18n';

export interface UpdateInfo {
  version: string;
}

export interface UpdateToast {
  kind: 'info';
  title: string;
  body: string;
  persistent: true;
  action: { label: string; onClick: () => void };
}

export interface UpdateDownloadedDeps {
  /** Toast push handler (typically from `useToast()`). */
  push: (toast: UpdateToast) => void;
}

/**
 * Subscribes to `update:downloaded` from the main process and surfaces a
 * persistent toast with a Restart button. Only fires once per session —
 * the Settings → Updates pane shows the same state for users who dismiss.
 *
 * Hook-form rewrite of the inline `<UpdateDownloadedBridge />` component
 * that used to live at the bottom of App.tsx, extracted under Task #724.
 */
export function useUpdateDownloadedBridge(deps: UpdateDownloadedDeps): void {
  const { push } = deps;
  useEffect(() => {
    let shown = false;
    const off = window.ccsm?.onUpdateDownloaded((info: UpdateInfo) => {
      if (shown) return;
      shown = true;
      push({
        kind: 'info',
        title: i18next.t('settings:updates.downloadedToastTitle'),
        body: i18next.t('settings:updates.downloadedToastBody', {
          version: info.version,
        }),
        persistent: true,
        action: {
          label: i18next.t('settings:updates.downloadedToastAction'),
          onClick: () => {
            void window.ccsm?.updatesInstall();
          },
        },
      });
    });
    return () => {
      if (off) off();
    };
  }, [push]);
}
