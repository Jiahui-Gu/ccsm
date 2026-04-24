import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { DURATION_RAW, EASING } from '../../lib/motion';

/**
 * Visual variant of the banner. Maps to a (background, foreground) color pair
 * baked into the global token palette so light + dark themes track together.
 *
 *   error   — destructive / blocking failures (red)
 *   warning — degraded / needs-attention state (amber)
 *   info    — neutral guidance (steel/blue)
 *
 * Only three variants are exposed deliberately: this component owns the
 * "top-of-pane status strip" surface, NOT every possible callout.
 */
export type TopBannerVariant = 'error' | 'warning' | 'info';

export interface TopBannerProps {
  /** Visual severity. Drives bg/fg color pair. */
  variant: TopBannerVariant;
  /** Leading icon (typically a `lucide-react` glyph at size 14). */
  icon?: React.ReactNode;
  /**
   * Short, sentence-case headline (e.g. "Failed to start Claude").
   * Required because every banner needs a scannable label for the
   * `role="alert"` announcement.
   */
  title: string;
  /**
   * Optional secondary line. String renders muted + monospace (good for
   * error codes); ReactNode lets callers compose richer content (e.g. an
   * inline link). Truncated to one line to keep the strip slim.
   */
  body?: React.ReactNode;
  /**
   * Action buttons rendered to the right of the body, before the dismiss
   * button. Pass styled `<button>`s directly so each banner keeps its own
   * CTA copy/icon — TopBanner only enforces *placement*, not styling.
   *
   * Convention: primary action first, secondary actions after.
   */
  actions?: React.ReactNode;
  /**
   * If provided, a trailing dismiss button (×) is rendered with this
   * handler. Omit when the banner's visibility is fully controlled by the
   * underlying state (e.g. CLI-missing strip auto-hides once configured).
   */
  onDismiss?: () => void;
  /** ARIA label for the dismiss button. Defaults to "Dismiss". */
  dismissLabel?: string;
  /**
   * Stable key for `<AnimatePresence>` so successive banners (e.g. a new
   * diagnostic replacing an old one) animate as a swap, not a no-op
   * re-render. When omitted, the strip just animates on mount/unmount of
   * the wrapping consumer.
   */
  presenceKey?: string | number;
  /** Test hook applied to the outer motion wrapper. */
  testId?: string;
  /** Extra class for the inner content row (rare — escape hatch only). */
  className?: string;
}

/**
 * Color tokens per variant. Background uses a dark, low-chroma surface so
 * the strip reads as a status bar (not a marketing callout); foreground is
 * bumped a step toward white for AA contrast against the bg.
 */
const VARIANT_STYLES: Record<TopBannerVariant, string> = {
  error: 'bg-[oklch(0.3_0.11_25)] text-[oklch(0.95_0.06_25)]',
  warning: 'bg-[oklch(0.32_0.08_75)] text-[oklch(0.94_0.06_90)]',
  info: 'bg-[oklch(0.30_0.05_240)] text-[oklch(0.94_0.02_240)]',
};

/**
 * Unified top-of-pane status banner. Wraps every variant of the
 * "something needs your attention up here" pattern (agent init failed,
 * agent diagnostic, CLI missing, …) so spacing, motion, a11y, and
 * dismiss-button placement stay consistent.
 *
 * Accessibility:
 *   - `role="alert"` on the inner row so screen readers announce the
 *     contents when the banner appears, even though it's outside the
 *     focused element.
 *   - `aria-live="polite"` so a NEW banner replacing an existing one
 *     gets re-announced without interrupting whatever the user is
 *     currently typing/reading.
 *   - Dismiss button has an explicit `aria-label` (defaulting to
 *     "Dismiss") so it isn't announced as just "×".
 *
 * Motion: fades + collapses height via `DURATION_RAW.ms150 +
 * EASING.enter` to match the existing banner family. Override is
 * intentionally NOT exposed — the whole point is consistency.
 */
export function TopBanner({
  variant,
  icon,
  title,
  body,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss',
  presenceKey,
  testId,
  className,
}: TopBannerProps) {
  return (
    <motion.div
      key={presenceKey}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: DURATION_RAW.ms150, ease: EASING.enter }}
      className="overflow-hidden"
      data-top-banner=""
      data-variant={variant}
      data-testid={testId}
    >
      <div
        role="alert"
        aria-live="polite"
        className={cn(
          'flex items-center gap-2 px-3 py-2 border-b border-border-subtle',
          VARIANT_STYLES[variant],
          className
        )}
      >
        {icon && <span className="shrink-0 inline-flex items-center">{icon}</span>}
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-meta font-semibold">{title}</span>
          {body !== undefined && body !== null && (
            <span
              className={cn(
                'text-[11px] truncate opacity-90',
                typeof body === 'string' && 'font-mono'
              )}
            >
              {body}
            </span>
          )}
        </div>
        {actions && (
          <div className="shrink-0 flex items-center gap-1.5" data-top-banner-actions="">
            {actions}
          </div>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            data-top-banner-dismiss=""
            className={cn(
              'shrink-0 h-7 w-7 rounded inline-flex items-center justify-center',
              'bg-black/10 hover:bg-black/25 active:bg-black/35 transition-colors duration-150',
              'outline-none focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]'
            )}
          >
            <X size={13} className="stroke-[2]" />
          </button>
        )}
      </div>
    </motion.div>
  );
}

/**
 * Convenience wrapper that pairs `TopBanner` with `<AnimatePresence>` so
 * conditional callers can write
 *
 *   <TopBannerPresence>{open && <TopBanner ... />}</TopBannerPresence>
 *
 * without re-importing AnimatePresence everywhere. Pure passthrough — no
 * behavior of its own.
 */
export function TopBannerPresence({ children }: { children: React.ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}
