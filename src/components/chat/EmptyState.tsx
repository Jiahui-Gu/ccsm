import { useTranslation } from '../../i18n/useTranslation';

export function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 gap-2">
      <div className="font-mono text-chrome text-fg-tertiary">{t('chat.ready')}</div>
      {/* One terse CTA hint below the ready line. We deliberately keep it to
          a single sentence — adding pseudo-suggestions ("Try asking…") here
          encourages users to type meaningless prompts; this just tells them
          the basic mechanic. The kbd chip mirrors the shortcut hints under
          the composer so the visual vocabulary stays consistent. */}
      <div
        className="font-mono text-mono-xs text-fg-disabled flex items-center gap-1.5 select-none"
        aria-hidden
      >
        <span>{t('chatStream.emptyHint')}</span>
        <kbd className="rounded-sm border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-fg-tertiary leading-none">
          Enter
        </kbd>
      </div>
    </div>
  );
}
