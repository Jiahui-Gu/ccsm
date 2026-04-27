import { useTranslation } from '../../../i18n/useTranslation';

/**
 * Read-only trace block left behind after the user resolves a permission
 * prompt. Replaces the original waiting block in place so the chat preserves
 * a scrollable record of allow/deny decisions (otherwise the prompt would
 * vanish without a trace and users couldn't audit what they approved).
 */
export function SystemTraceBlock({
  subkind,
  toolName,
  toolInputSummary,
  decision
}: {
  subkind: 'permission-resolved';
  toolName: string;
  toolInputSummary: string;
  decision: 'allowed' | 'denied';
}) {
  // Only one subkind today; the discriminator exists so future system traces
  // (e.g. queued-message-cleared, autopilot-step) can land here without
  // schema churn.
  void subkind;
  const { t } = useTranslation();
  const denied = decision === 'denied';
  const label = denied ? t('chat.permResolvedDenied') : t('chat.permResolvedAllowed');
  return (
    <div
      role="status"
      data-system-trace="permission-resolved"
      data-decision={decision}
      className="relative my-1 rounded-sm border border-border-subtle bg-bg-elevated/40 pl-3 pr-3 py-1 text-meta text-fg-tertiary font-mono"
    >
      <span
        aria-hidden
        className={
          'absolute left-0 top-0 bottom-0 w-[2px] rounded-l-sm ' +
          (denied ? 'bg-state-error/70' : 'bg-state-running/70')
        }
      />
      <span className={denied ? 'text-state-error-fg' : 'text-fg-secondary'}>{label}</span>
      <span className="text-fg-tertiary">: </span>
      <span className="text-fg-secondary">{toolName}</span>
      {toolInputSummary && (
        <span className="text-fg-tertiary"> ({toolInputSummary})</span>
      )}
    </div>
  );
}
