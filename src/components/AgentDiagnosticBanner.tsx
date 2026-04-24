import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { TopBanner, TopBannerPresence } from './chrome/TopBanner';

/**
 * Non-intrusive banner showing the most recent agent-layer diagnostic (F1).
 *
 * Diagnostics originate in `electron/agent/sessions.ts` (init handshake
 * failure, control_request timeout, ...) and arrive through
 * `agent:diagnostic` IPC → store. Only the latest non-dismissed entry
 * renders. Dismissing hides the current one; a newer diagnostic will pop
 * a fresh banner.
 *
 * Layout/motion/a11y are owned by `<TopBanner />` (#237). This component
 * just maps store state → variant + copy.
 */
export function AgentDiagnosticBanner() {
  const { t } = useTranslation();
  const diagnostics = useStore((s) => s.diagnostics);
  const activeId = useStore((s) => s.activeId);
  const dismiss = useStore((s) => s.dismissDiagnostic);

  // Most recent non-dismissed entry for the active session. Per-session
  // scoping avoids a warn from session A from masking the chat for session B
  // the user just switched to. (We still keep all entries in the store so a
  // future "recent diagnostics" panel could read them.)
  const latest = React.useMemo(() => {
    for (let i = diagnostics.length - 1; i >= 0; i--) {
      const d = diagnostics[i];
      if (!d.dismissed && d.sessionId === activeId) return d;
    }
    return null;
  }, [diagnostics, activeId]);

  return (
    <TopBannerPresence>
      {latest && (
        <TopBanner
          variant={latest.level === 'error' ? 'error' : 'warning'}
          presenceKey={latest.id}
          testId="agent-diagnostic-banner"
          icon={<AlertTriangle size={13} className="stroke-[2]" />}
          title={latest.level === 'error' ? t('banner.agentDiagnostic.titleError') : t('banner.agentDiagnostic.titleWarning')}
          body={latest.message}
          onDismiss={() => dismiss(latest.id)}
          dismissLabel={t('banner.agentDiagnostic.dismiss')}
        />
      )}
    </TopBannerPresence>
  );
}
