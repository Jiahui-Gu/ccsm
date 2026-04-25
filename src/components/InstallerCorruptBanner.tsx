import React from 'react';
import { AlertOctagon } from 'lucide-react';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { TopBanner, TopBannerPresence } from './chrome/TopBanner';

/**
 * Red banner shown at the top of the right pane whenever the SDK reports
 * `CLAUDE_NOT_FOUND` from `agent:start`. CCSM ships the Claude binary
 * inside the installer (PR-B's `scripts/after-pack.cjs` fail-fasts when the
 * binary is missing during build), so reaching this state on a real install
 * means the installer payload was tampered with or partially uninstalled.
 *
 * Intentionally not user-dismissible — until the install is repaired,
 * sessions cannot start, so a transient hide would be a worse UX than a
 * persistent banner. Wraps the shared `<TopBanner />` for layout / motion /
 * a11y consistency with its sibling banners.
 */
export function InstallerCorruptBanner() {
  const { t } = useTranslation();
  const installerCorrupt = useStore((s) => s.installerCorrupt);

  return (
    <TopBannerPresence>
      {installerCorrupt && (
        <TopBanner
          variant="error"
          presenceKey="installer-corrupt"
          testId="installer-corrupt-banner"
          icon={<AlertOctagon size={13} className="stroke-[2]" />}
          title={t('installerCorrupt.title')}
          body={t('installerCorrupt.body')}
        />
      )}
    </TopBannerPresence>
  );
}
