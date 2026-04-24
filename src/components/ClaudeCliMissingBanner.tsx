import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { TopBanner, TopBannerPresence } from './chrome/TopBanner';

/**
 * Amber banner shown at the top of the right pane whenever the user has
 * dismissed (minimized) the CLI-missing dialog. Clicking the action
 * re-opens the wizard. Stays visible until the CLI is actually configured;
 * intentionally has NO dismiss button (state is auto-driven).
 *
 * Wraps the shared `<TopBanner />` for layout / motion / a11y consistency
 * with its sibling banners (#237).
 */
export function ClaudeCliMissingBanner() {
  const { t } = useTranslation();
  const cliStatus = useStore((s) => s.cliStatus);
  const openDialog = useStore((s) => s.openCliDialog);

  return (
    <TopBannerPresence>
      {cliStatus.state === 'missing' && !cliStatus.dialogOpen && (
        <TopBanner
          variant="warning"
          presenceKey="cli-missing"
          testId="claude-cli-missing-banner"
          icon={<AlertTriangle size={13} className="stroke-[2]" />}
          title={t('cli.bannerNotConfigured')}
          actions={
            <button
              type="button"
              onClick={openDialog}
              data-cli-missing-setup
              className={cn(
                'shrink-0 h-7 px-2.5 rounded text-meta font-medium inline-flex items-center',
                'bg-black/20 hover:bg-black/30 active:bg-black/40 transition-colors duration-150',
                'outline-none focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]'
              )}
            >
              {t('cli.bannerSetUp')}
            </button>
          }
        />
      )}
    </TopBannerPresence>
  );
}
