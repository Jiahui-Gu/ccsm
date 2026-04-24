import { AlertCircle } from 'lucide-react';
import { useTranslation } from '../../../i18n/useTranslation';

export function ErrorBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="relative my-1.5 rounded-md border border-state-error/40 bg-state-error-soft pl-3 pr-3 py-2 text-chrome text-state-error-fg"
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-error rounded-l-md" />
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="text-state-error mt-0.5 shrink-0" aria-label={t('chat.errorLabel')} />
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    </div>
  );
}
