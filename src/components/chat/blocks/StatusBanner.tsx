import { useTranslation } from '../../../i18n/useTranslation';

export function StatusBanner({ tone, title, detail }: { tone: 'info' | 'warn'; title: string; detail?: string }) {
  const { t } = useTranslation();
  const isWarn = tone === 'warn';
  return (
    <div
      role="status"
      className={
        'relative my-1.5 rounded-md border pl-3 pr-3 py-1.5 text-xs ' +
        (isWarn
          ? 'border-state-waiting/40 bg-state-waiting/[0.06] text-fg-secondary'
          : 'border-border-subtle bg-bg-elevated/60 text-fg-tertiary')
      }
    >
      <span
        aria-hidden
        className={
          'absolute left-0 top-0 bottom-0 w-[2px] rounded-l-md ' +
          (isWarn ? 'bg-state-waiting' : 'bg-border-strong')
        }
      />
      <div className="flex items-baseline gap-2">
        <span className={'font-mono uppercase tracking-wider text-mono-xs ' + (isWarn ? 'text-state-waiting' : 'text-fg-tertiary')}>
          {isWarn ? t('chat.warnLabel') : t('chat.infoLabel')}
        </span>
        <span className={isWarn ? 'text-fg-primary' : 'text-fg-secondary'}>{title}</span>
        {detail && <span className="text-fg-tertiary">— {detail}</span>}
      </div>
    </div>
  );
}
