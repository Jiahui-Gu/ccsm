// First-run crash-upload consent modal. Phase 4 crash observability
// (spec §7, plan phase 4: first-run consent).
//
// Behavior contract:
//   - Pops on first launch when persisted `crashUploadConsent === 'pending'`
//     (the default, so a fresh install always sees it once).
//   - Two buttons: "Allow" → 'opted-in', "Not now" → 'opted-out'. No
//     "remind me later" — the user can flip later via Settings.
//   - The body explicitly states local crash logs are saved regardless of
//     the choice (the user's hard constraint surfaced in copy).
//   - Persists via `window.ccsm.saveState('crashUploadConsent', ...)`. The
//     main-process `subscribeCrashConsentInvalidation()` drops the cache on
//     write so the gate takes effect on the next captured event.

import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent } from './ui/Dialog';
import { Button } from './ui/Button';
import { useTranslation } from '../i18n/useTranslation';

const CONSENT_KEY = 'crashUploadConsent';

type Consent = 'pending' | 'opted-in' | 'opted-out';

function isConsent(v: string | null | undefined): v is Consent {
  return v === 'pending' || v === 'opted-in' || v === 'opted-out';
}

export function CrashConsentModal() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [whatsSentOpen, setWhatsSentOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await window.ccsm?.loadState(CONSENT_KEY);
        if (cancelled) return;
        const consent: Consent = isConsent(raw) ? raw : 'pending';
        if (consent === 'pending') setOpen(true);
      } catch {
        /* db unreachable on boot — leave the modal closed; we'll re-prompt
           next launch since nothing was persisted. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = (next: Consent) => {
    setOpen(false);
    void window.ccsm?.saveState(CONSENT_KEY, next);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) persist('opted-out'); }}>
      <DialogContent
        title={t('consentModal.title')}
        width="480px"
        hideClose={true}
        // Block focus trap escape paths — the user must click one of the
        // two buttons; closing via overlay click defaults to 'opted-out'
        // (handled via onOpenChange above).
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        data-crash-consent-modal
      >
        <div className="p-5 space-y-4">
          <p className="text-chrome text-fg-secondary leading-relaxed">
            {t('consentModal.body')}
          </p>

          <details
            open={whatsSentOpen}
            onToggle={(e) => setWhatsSentOpen((e.currentTarget as { open: boolean }).open)}
            className="text-meta text-fg-tertiary"
          >
            <summary className="cursor-pointer select-none text-fg-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-sm">
              {t('consentModal.whatsSent')}
            </summary>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>{t('consentModal.whatsSentItem1')}</li>
              <li>{t('consentModal.whatsSentItem2')}</li>
              <li>{t('consentModal.whatsSentItem3')}</li>
            </ul>
          </details>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="md"
              onClick={() => persist('opted-out')}
              data-crash-consent-not-now
              autoFocus
            >
              {t('consentModal.notNow')}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => persist('opted-in')}
              data-crash-consent-allow
            >
              {t('consentModal.allow')}
            </Button>
          </div>

          <p className="text-meta text-fg-tertiary">{t('consentModal.footer')}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
