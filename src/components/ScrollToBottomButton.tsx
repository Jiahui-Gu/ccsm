import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';

// Floating "jump to bottom" affordance for the terminal viewport.
// Mounted inside the TerminalPane's relative wrapper so it absolutely
// positions over the bottom-right corner of the xterm host. Only
// renders when the user has scrolled up (atBottom === false); fades
// itself out the moment they hit bottom again (either by clicking
// this button or by xterm's own behaviour after Page Down / scroll
// wheel down).
//
// Sits above xterm's canvas (z-10) so it stays clickable — the canvas
// renderer stacks its own absolutely-positioned canvases inside the
// host and would otherwise paint over the button on first render.
//
// Visual: 32px circle, IconButton's `raised` aesthetic (matches the
// other elevated controls in the app) with the lucide ArrowDown glyph.
// Framer-motion handles fade + 4px translate for entry/exit so the
// button feels like it slid up from the corner rather than popping.
export function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AnimatePresence>
      {visible ? (
        <motion.button
          type="button"
          onClick={onClick}
          aria-label={t('terminal.scrollToBottom')}
          title={t('terminal.scrollToBottom')}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
          whileTap={{ scale: 0.94 }}
          data-scroll-to-bottom
          className={[
            'absolute bottom-4 right-4 z-10',
            'inline-grid place-items-center',
            'h-8 w-8 rounded-full',
            'text-fg-secondary',
            'bg-[oklch(0.32_0.003_240)] border border-[oklch(0.42_0.003_240)]',
            'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.10),0_2px_8px_0_oklch(0_0_0_/_0.45)]',
            'hover:bg-[oklch(0.38_0.003_240)] hover:text-fg-primary hover:border-[oklch(0.50_0.003_240)]',
            'active:bg-[oklch(0.30_0.003_240)]',
            'focus-visible:outline-none focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.10),0_2px_8px_0_oklch(0_0_0_/_0.45),0_0_0_2px_oklch(1_0_0_/_0.18)]',
            'transition-[background-color,border-color,color] duration-150',
          ].join(' ')}
        >
          <ArrowDown size={16} strokeWidth={2} />
        </motion.button>
      ) : null}
    </AnimatePresence>
  );
}

export default ScrollToBottomButton;
