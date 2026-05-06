import React from 'react';
import { AlertOctagon } from 'lucide-react';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { TopBanner, TopBannerPresence } from './chrome/TopBanner';

/**
 * Task #639 (v0.3 ship-blocker) — fatal banner shown at the top of the
 * right pane whenever the daemon reported `initDb` failure (better-sqlite3
 * ABI mismatch / EACCES on the per-user data dir / ENOSPC on the WAL
 * write / sqlite header corruption that survived `ensureHealthyDb` /
 * the `CCSM_TEST_BREAK_DB=1` test seam).
 *
 * Why no dismiss button: storage failure means every saveState the user
 * makes will silently evaporate on restart (the original dogfood-575 P0
 * — see `dev-575-dogfood` report). We MUST surface this to the user
 * persistently — a transient toast hides itself before the user has a
 * chance to copy logs / safely quit.
 *
 * Stacked next to `<InstallerCorruptBanner />` inside the right-pane
 * frame's banner stack; both share the `error` variant + the same
 * `<AlertOctagon />` icon vocabulary.
 *
 * Body line carries the daemon-supplied `reason` (the raw initDb error
 * message — typically a NODE_MODULE_VERSION mismatch line or a fs
 * EACCES). Kept as monospace via the TopBanner string-body branch so the
 * user can copy it verbatim into a bug report.
 */
export function StorageHealthBanner() {
  const { t } = useTranslation();
  const storageHealth = useStore((s) => s.storageHealth);

  const broken = storageHealth !== null && storageHealth.ok === false;

  return (
    <TopBannerPresence>
      {broken && (
        <TopBanner
          variant="error"
          presenceKey="storage-health"
          testId="storage-health-banner"
          icon={<AlertOctagon size={13} className="stroke-[2]" />}
          title={t('storageHealth.title')}
          body={storageHealth?.reason ?? t('storageHealth.bodyFallback')}
        />
      )}
    </TopBannerPresence>
  );
}
