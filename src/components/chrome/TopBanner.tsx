import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
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
   * live-region announcement (role derived from `variant`).
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
 * Action button styling for buttons that sit ON TOP of a `<TopBanner />`
 * surface (retry / reconfigure / set-up / dismiss / …). Centralises four
 * previously-duplicated inline impls (#273) so every banner CTA gets the
 * same focus halo, hover/active feedback, and motion timing.
 *
 * Two axes:
 *   - `tone`     — background intensity. `primary` (more saturated black
 *                  overlay) for the canonical action, `secondary` for
 *                  supporting actions, `dismiss` matches the `×` button.
 *   - `shape`    — `pill` for label (or icon + label) buttons, `square`
 *                  for icon-only (e.g. the dismiss `×`).
 *
 * Background uses `black/N` overlays on top of the variant's already-tinted
 * surface so a single set of tone classes works across error/warning/info
 * — the underlying hue bleeds through. Focus halo is a 2px white ring
 * (`oklch(1 0 0 / 0.18)`) — a colored ring would clash with each banner
 * variant.
 */
export const bannerActionVariants = cva(
  cn(
    'shrink-0 inline-flex items-center justify-center rounded font-medium',
    'transition-colors duration-150',
    'outline-none focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]',
    'disabled:opacity-60 disabled:cursor-not-allowed'
  ),
  {
    variants: {
      tone: {
        // Primary CTA on the banner (e.g. Retry on the init-failed banner).
        // Slightly stronger contrast so it's the obvious target.
        primary: 'bg-black/25 hover:bg-black/35 active:bg-black/45',
        // Supporting CTA (e.g. Reconfigure, Set up). Lighter so it visually
        // sits behind the primary action without disappearing.
        secondary: 'bg-black/10 hover:bg-black/25 active:bg-black/35',
        // Mid-weight overlay used by the standalone CLI-missing banner where
        // there's only one action and no primary/secondary hierarchy.
        neutral: 'bg-black/20 hover:bg-black/30 active:bg-black/40',
        // Dismiss `×`. Same lightness as `secondary`; kept separate so its
        // intent reads at the call site.
        dismiss: 'bg-black/10 hover:bg-black/25 active:bg-black/35',
      },
      shape: {
        // Label (with optional leading icon). 7×label height, snug padding.
        pill: 'h-7 px-2.5 text-meta gap-1.5',
        // Icon-only square (dismiss button).
        square: 'h-7 w-7',
      },
    },
    defaultVariants: { tone: 'primary', shape: 'pill' },
  }
);

export type BannerActionTone = NonNullable<VariantProps<typeof bannerActionVariants>['tone']>;
export type BannerActionShape = NonNullable<VariantProps<typeof bannerActionVariants>['shape']>;

export interface TopBannerActionProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    VariantProps<typeof bannerActionVariants> {
  /**
   * Optional ref forwarded to the underlying `<button>`. Banners rarely
   * need this but keyboard-focus probes do.
   */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

/**
 * Single source of truth for buttons that sit on top of a `<TopBanner />`
 * surface. Always renders `<button type="button">` (banner CTAs are never
 * form submits) and forwards every other prop, so callers keep their
 * existing `data-*` hooks, `onClick`, `disabled`, `aria-label`, etc.
 */
export function TopBannerAction({
  tone,
  shape,
  className,
  buttonRef,
  children,
  ...rest
}: TopBannerActionProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cn(bannerActionVariants({ tone, shape }), className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Unified top-of-pane status banner. Wraps every variant of the
 * "something needs your attention up here" pattern (agent init failed,
 * agent diagnostic, CLI missing, …) so spacing, motion, a11y, and
 * dismiss-button placement stay consistent.
 *
 * Accessibility:
 *   - ARIA role is derived from `variant` so screen readers don't
 *     over-announce non-critical state:
 *       error            → `role="alert"`   (assertive semantics; blocking failure)
 *       warning | info   → `role="status"`  (advisory; politely announced)
 *     Both roles pair with `aria-live="polite"` so a NEW banner
 *     replacing an existing one gets re-announced without interrupting
 *     whatever the user is currently typing/reading.
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
  // Match ARIA role to severity. `alert` is assertive and intended for
  // blocking failures; warning/info are advisory and should use the
  // gentler `status` role so screen readers don't treat them as
  // interruptions. `aria-live="polite"` is kept for both so the queued
  // announcement still happens.
  const role = variant === 'error' ? 'alert' : 'status';
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
        role={role}
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
                'text-meta truncate opacity-90',
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
          <TopBannerAction
            tone="dismiss"
            shape="square"
            onClick={onDismiss}
            aria-label={dismissLabel}
            data-top-banner-dismiss=""
          >
            <X size={13} className="stroke-[2]" />
          </TopBannerAction>
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

/**
 * Stack container for vertically stacked `<TopBanner />` instances (#287).
 *
 * Problem it solves: every TopBanner renders its own `border-b` separator
 * so that, when only one banner is showing, there is a single 1px line
 * between the strip and the content beneath it. When TWO banners stack
 * (e.g. AgentInitFailed + ClaudeCliMissing both visible), each banner
 * draws its own `border-b`, producing TWO horizontal hairlines back-to-back
 * — readable as a doubled / heavier divider that other UI surfaces never
 * use, and visually noisy.
 *
 * Fix: a CSS-only adjustment on the wrapper that nullifies `border-b` on
 * every non-last banner inside the stack via the
 * `[data-top-banner]:not(:last-child)>div { border-bottom-width: 0 }`
 * descendant selector. The selector targets the inner `<div role="...">`
 * (which actually carries the border) inside each banner's outer
 * `motion.div`. Single-banner case is untouched: the only banner is
 * `:last-child` and keeps its border.
 *
 * Usage at call site (App.tsx):
 *
 *   <TopBannerStack>
 *     <ClaudeCliMissingBanner />
 *     <AgentInitFailedBanner ... />
 *     <AgentDiagnosticBanner />
 *   </TopBannerStack>
 *
 * Each banner internally still uses its own `<TopBannerPresence>` —
 * stacking does not interfere with mount/unmount animations.
 */
export function TopBannerStack({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-top-banner-stack=""
      className={cn(
        '[&_[data-top-banner]:not(:last-child)>div]:border-b-0',
        className
      )}
    >
      {children}
    </div>
  );
}
