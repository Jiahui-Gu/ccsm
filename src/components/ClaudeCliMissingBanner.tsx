import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';

/**
 * Amber banner shown at the top of the right pane whenever the user has
 * dismissed (minimized) the CLI-missing dialog. Clicking it re-opens the
 * wizard. Stays visible until the CLI is actually configured.
 */
export function ClaudeCliMissingBanner() {
  const { t } = useTranslation();
  const cliStatus = useStore((s) => s.cliStatus);
  const openDialog = useStore((s) => s.openCliDialog);

  if (cliStatus.state !== 'missing' || cliStatus.dialogOpen) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle',
        'bg-[oklch(0.32_0.08_75)] text-[oklch(0.94_0.06_90)]'
      )}
      role="status"
    >
      <AlertTriangle size={13} className="stroke-[2] shrink-0" />
      <span className="flex-1 min-w-0 truncate text-meta">
        {t('cli.bannerNotConfigured')}
      </span>
      <button
        type="button"
        onClick={openDialog}
        className={cn(
          'shrink-0 h-6 px-2 rounded text-meta font-medium',
          'bg-black/20 hover:bg-black/30 transition-colors duration-150',
          'outline-none focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.15)]'
        )}
      >
        {t('cli.bannerSetUp')}
      </button>
    </div>
  );
}
