import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { TopBanner, TopBannerAction, TopBannerPresence } from './chrome/TopBanner';

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
            <TopBannerAction
              tone="neutral"
              onClick={openDialog}
              data-cli-missing-setup
            >
              {t('cli.bannerSetUp')}
            </TopBannerAction>
          }
        />
      )}
    </TopBannerPresence>
  );
}
