import { useTranslation } from '../../i18n/useTranslation';

export function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="font-mono text-chrome text-fg-tertiary">{t('chat.ready')}</div>
    </div>
  );
}
