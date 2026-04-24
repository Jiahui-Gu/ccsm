import { AlertCircle } from 'lucide-react';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * Inline banner shown when loading persisted history fails. Lives inside the
 * chat scroll area so the user sees the failure immediately and has a direct
 * path to recover via the Retry button (UI-17). On retry we clear both the
 * sentinel `[]` seeded on failure and the error entry, then kick loadMessages
 * fresh.
 */
export function LoadHistoryErrorBlock({
  message,
  onRetry
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="chat-load-history-error"
      className="relative my-1.5 rounded-md border border-state-error/40 bg-state-error-soft pl-3 pr-3 py-2 text-sm text-state-error-fg"
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-error rounded-l-md" />
      <div className="flex items-start gap-2">
        <AlertCircle
          size={14}
          className="text-state-error mt-0.5 shrink-0"
          aria-label={t('chat.errorLabel')}
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t('chat.loadHistoryFailed')}</div>
          {message && (
            <div className="mt-0.5 font-mono text-xs text-fg-tertiary whitespace-pre-wrap break-words">
              {message}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRetry}
          data-testid="chat-load-history-retry"
          className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-sm border border-state-error/50 text-mono-xs font-mono text-state-error-fg hover:bg-state-error/10 active:bg-state-error/15 transition-colors duration-150 ease-out outline-none focus-ring-destructive"
        >
          {t('chat.retry')}
        </button>
      </div>
    </div>
  );
}
