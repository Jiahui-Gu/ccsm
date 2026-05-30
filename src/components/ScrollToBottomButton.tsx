import { ArrowDown } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';

// Floating "jump to bottom" affordance for the terminal viewport.
// Mounted inside the TerminalPane's relative wrapper so it absolutely
// positions over the bottom-right corner of the xterm host.
//
// Always rendered while the terminal is in the `ready` state — the
// previous `atBottom`-gated visibility was flaky in practice (xterm's
// onScroll/onLineFeed signals can miss edges, leaving the button hidden
// when the user has scrolled up). Clicking while already at bottom is a
// no-op (xterm's scrollToBottom is idempotent), so always-on costs us
// nothing behaviourally.
//
// Sits above xterm's canvas (z-10) so it stays clickable — the canvas
// renderer stacks its own absolutely-positioned canvases inside the
// host and would otherwise paint over the button on first render.
//
// Visual: 32px circle, IconButton's `raised` aesthetic (matches the
// other elevated controls in the app) with the lucide ArrowDown glyph.
export function ScrollToBottomButton({
  onClick,
}: {
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('terminal.scrollToBottom')}
      title={t('terminal.scrollToBottom')}
      data-scroll-to-bottom
      className={[
        'absolute bottom-3 left-1/2 -translate-x-1/2 z-10',
        'inline-grid place-items-center',
        'h-8 w-8 rounded-full',
        'text-fg-secondary',
        'bg-[oklch(0.32_0.003_240)] border border-[oklch(0.42_0.003_240)]',
        'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.10),0_2px_8px_0_oklch(0_0_0_/_0.45)]',
        'hover:bg-[oklch(0.38_0.003_240)] hover:text-fg-primary hover:border-[oklch(0.50_0.003_240)]',
        'active:bg-[oklch(0.30_0.003_240)] active:scale-[0.94]',
        'focus-visible:outline-none focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.10),0_2px_8px_0_oklch(0_0_0_/_0.45),0_0_0_2px_oklch(1_0_0_/_0.18)]',
        'transition-[background-color,border-color,color,transform] duration-150',
      ].join(' ')}
    >
      <ArrowDown size={16} strokeWidth={2} />
    </button>
  );
}

export default ScrollToBottomButton;
